#!/bin/sh
# Creates the EFS filesystem, mount targets, security group, and access point that back a
# VPC-mode agent runtime. EVERY STEP MUTATES AWS. Re-running is safe.
#
# Why EFS at all: managed session storage is capped at 1 GB, is Preview, and is WIPED on
# every agent runtime version update — i.e. every image redeploy destroys the workspace.
# EFS has no such cap and explicitly survives version updates.
#
# Why the access point root is /workspaces and not /: the eventual model is one access
# point per user rooted at /workspaces/<user_id>. Rooting today's single-tenant access
# point one level above that means adding users later is a second access point plus a
# mapping table, not a migration.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
NAME="${CUBE_EFS_NAME:-coding-cube}"
SG_NAME="${CUBE_SG_NAME:-coding-cube-runtime}"
# One level above the per-user roots so a later per-user access point nests cleanly.
AP_ROOT="${CUBE_AP_ROOT:-/workspaces}"
# The container runs as uid 0 (measured on the live platform), so the access point must
# present files as root or every write lands owned by someone the container cannot be.
AP_UID="${CUBE_AP_UID:-0}"
AP_GID="${CUBE_AP_GID:-0}"

VPC="${CUBE_VPC:-}"
SUBNETS="${CUBE_SUBNETS:-}"

DRY_RUN=0
case "${1:-}" in
  --dry-run|--plan) DRY_RUN=1 ;;
  '') ;;
  *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac

say() { printf '\033[36m>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31mx\033[0m %s\n' "$1" >&2; exit 1; }
run() { printf '\033[35m$\033[0m %s\n' "$*" >&2; "$@"; }

command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'no usable AWS credentials'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "credentials are for account $CALLER but this script targets $ACCOUNT"

if [ -z "$VPC" ]; then
  VPC=$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true \
    --query 'Vpcs[0].VpcId' --output text)
  [ "$VPC" != 'None' ] || die 'no default VPC; set CUBE_VPC'
fi
if [ -z "$SUBNETS" ]; then
  # EFS allows exactly one mount target per AZ, so one default subnet per AZ is the
  # natural set. AgentCore places its ENIs in these same subnets.
  SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true \
    --query 'Subnets[].SubnetId' --output text)
fi
[ -n "$SUBNETS" ] || die 'no subnets resolved; set CUBE_SUBNETS'

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    VPC             $VPC
    Subnets         $(echo "$SUBNETS" | tr '\n' ' ')
    Security group  $SG_NAME          (self-referencing 2049, all egress)
    EFS filesystem  $NAME             (encrypted, elastic throughput)
    Mount targets   one per subnet
    Access point    root $AP_ROOT, posix uid=$AP_UID gid=$AP_GID

  EFS is billed per GB stored (~\$0.30/GB-month standard). Mount targets and the access
  point are free. This script does NOT create a NAT gateway - whether one is needed is
  measured after the runtime is switched to VPC mode.

PLAN

if [ "$DRY_RUN" = 1 ]; then
  say 'Dry run - nothing was changed.'
  exit 0
fi

[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS. Type exactly: create efs %s\n> ' "$NAME"
read -r ANSWER
[ "$ANSWER" = "create efs $NAME" ] || die 'aborted'

# ── security group ──────────────────────────────────────────────────────────────
SG=$(aws ec2 describe-security-groups --region "$REGION" \
  --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="$SG_NAME" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
if [ "$SG" = 'None' ] || [ -z "$SG" ]; then
  SG=$(run aws ec2 create-security-group --region "$REGION" --vpc-id "$VPC" \
    --group-name "$SG_NAME" \
    --description 'Coding Cube AgentCore runtime and EFS mount targets' \
    --query GroupId --output text)
  say "Created security group $SG"
  # NFS from anything else in this group: the runtime ENIs and the mount targets both
  # carry it, so this is the narrowest rule that lets them talk.
  run aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG" \
    --protocol tcp --port 2049 --source-group "$SG" >/dev/null
  say 'Allowed NFS 2049 within the group'
else
  say "Security group $SG already exists"
fi

# ── filesystem ──────────────────────────────────────────────────────────────────
FS=$(aws efs describe-file-systems --region "$REGION" \
  --query "FileSystems[?Name=='$NAME'].FileSystemId | [0]" --output text 2>/dev/null || echo None)
if [ "$FS" = 'None' ] || [ -z "$FS" ]; then
  # Elastic throughput: no provisioned floor to pay for while the cube is asleep.
  FS=$(run aws efs create-file-system --region "$REGION" \
    --performance-mode generalPurpose --throughput-mode elastic --encrypted \
    --tags "Key=Name,Value=$NAME" \
    --query FileSystemId --output text)
  say "Created filesystem $FS"
  printf 'waiting for %s to become available' "$FS"
  while [ "$(aws efs describe-file-systems --region "$REGION" --file-system-id "$FS" \
    --query 'FileSystems[0].LifeCycleState' --output text)" != 'available' ]; do
    printf '.'; sleep 3
  done
  printf '\n'
else
  say "Filesystem $NAME already exists as $FS"
fi

# ── mount targets ───────────────────────────────────────────────────────────────
EXISTING=$(aws efs describe-mount-targets --region "$REGION" --file-system-id "$FS" \
  --query 'MountTargets[].SubnetId' --output text 2>/dev/null || true)
for SUBNET in $SUBNETS; do
  case " $EXISTING " in
    *" $SUBNET "*) say "Mount target in $SUBNET already exists"; continue ;;
  esac
  run aws efs create-mount-target --region "$REGION" --file-system-id "$FS" \
    --subnet-id "$SUBNET" --security-groups "$SG" --query MountTargetId --output text >/dev/null
  say "Created mount target in $SUBNET"
done

# ── access point ────────────────────────────────────────────────────────────────
AP=$(aws efs describe-access-points --region "$REGION" --file-system-id "$FS" \
  --query "AccessPoints[?Name=='$NAME'].AccessPointId | [0]" --output text 2>/dev/null || echo None)
if [ "$AP" = 'None' ] || [ -z "$AP" ]; then
  AP=$(run aws efs create-access-point --region "$REGION" --file-system-id "$FS" \
    --tags "Key=Name,Value=$NAME" \
    --posix-user "Uid=$AP_UID,Gid=$AP_GID" \
    --root-directory "Path=$AP_ROOT,CreationInfo={OwnerUid=$AP_UID,OwnerGid=$AP_GID,Permissions=0755}" \
    --query AccessPointId --output text)
  say "Created access point $AP"
else
  say "Access point $NAME already exists as $AP"
fi

printf 'waiting for %s to become available' "$AP"
while [ "$(aws efs describe-access-points --region "$REGION" --access-point-id "$AP" \
  --query 'AccessPoints[0].LifeCycleState' --output text)" != 'available' ]; do
  printf '.'; sleep 3
done
printf '\n'

AP_ARN="arn:aws:elasticfilesystem:$REGION:$ACCOUNT:access-point/$AP"
FS_ARN="arn:aws:elasticfilesystem:$REGION:$ACCOUNT:file-system/$FS"
SG_LIST=$(echo "$SG" | tr '\n' ' ')
SUBNET_LIST=$(echo "$SUBNETS" | tr '\n' ',' | sed 's/,$//')

cat <<DONE

> Ready.

  export CUBE_EFS_FS=$FS
  export CUBE_EFS_AP=$AP
  export CUBE_EFS_AP_ARN=$AP_ARN
  export CUBE_EFS_FS_ARN=$FS_ARN
  export CUBE_SG=$SG_LIST
  export CUBE_SUBNET_LIST=$SUBNET_LIST

  Then switch the runtime to VPC mode with the EFS mount:

    sh spike/aws/create-runtime.sh --efs

Teardown - DESTRUCTIVE, deletes every workspace on the filesystem:

  aws efs delete-access-point --region $REGION --access-point-id $AP
  for MT in \$(aws efs describe-mount-targets --region $REGION --file-system-id $FS \\
    --query 'MountTargets[].MountTargetId' --output text); do
    aws efs delete-mount-target --region $REGION --mount-target-id \$MT
  done
  # mount targets take ~60s to clear before the filesystem will delete
  aws efs delete-file-system --region $REGION --file-system-id $FS
  aws ec2 delete-security-group --region $REGION --group-id $SG

DONE
