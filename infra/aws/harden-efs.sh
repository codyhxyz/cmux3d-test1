#!/bin/sh
# Attaches a file system policy that refuses any mount not scoped to an access point.
# EVERY STEP MUTATES AWS. Re-running is safe. `--rollback` removes the policy.
#
# WHY THIS EXISTS - the gap in the per-user isolation argument.
#
# One access point per user, each rooted at /workspaces/<sub> with mode 0700, and a per-user
# execution role whose elasticfilesystem:AccessPointArn condition permits only that one
# access point. That is airtight for mounts the PLATFORM performs on the runtime's behalf.
#
# It says nothing about mounts performed from INSIDE the microVM. The container runs as uid
# 0 (measured, T-09), it sits in the same VPC and security group as the EFS mount targets,
# and that security group allows 2049 within itself - which is exactly what makes the
# platform's own mount work. By default EFS has no file system policy, and with no policy a
# client that can reach a mount target over NFS is authorised by POSIX permissions alone.
# Root is not squashed. So `mount -t nfs4 <mount-target>:/ /mnt/everyone` from one user's
# cube would expose every other user's /workspaces/<sub>, and 0700 would not stop it because
# the mounting process is root.
#
# The Deny below closes that: a raw NFS mount carries no elasticfilesystem:AccessPointArn
# context key, so it is denied, while the platform's access-point-scoped mount is unaffected.
#
# THIS IS UNVERIFIED. It is reasoned from the EFS authorization model, not measured, and the
# rest of this repository draws that line hard. Before trusting multi-user isolation, do the
# experiment in both directions - see "Verify by trying" at the end of this script's output.
#
# LOCKOUT RISK: a wrong policy here stops every runtime from mounting anything, and the
# symptom is a runtime that reaches READY and then fails every invocation. `--rollback` is
# one call and restores the default allow-all. Do this before adding real users, not after.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
EFS_FS="${CUBE_EFS_FS:-fs-01bc1a8b94bd929b7}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA=$(CDPATH= cd -- "$HERE/.." && pwd)
POLICY="$INFRA/policies/efs-filesystem-policy.json"

MODE=apply
DRY_RUN=0
case "${1:-}" in
  --dry-run|--plan) DRY_RUN=1 ;;
  --rollback) MODE=rollback ;;
  '') ;;
  *) printf 'usage: %s [--dry-run | --rollback]\n' "$0" >&2; exit 2 ;;
esac

say() { printf '\033[36m>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31mx\033[0m %s\n' "$1" >&2; exit 1; }
run() { printf '\033[35m$\033[0m %s\n' "$*" >&2; "$@"; }
aws_() { aws --region "$REGION" "$@"; }

command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'no usable AWS credentials'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "credentials are for account $CALLER but this script targets $ACCOUNT"
[ -f "$POLICY" ] || die "missing $POLICY"
aws_ efs describe-file-systems --file-system-id "$EFS_FS" >/dev/null 2>&1 \
  || die "filesystem $EFS_FS does not exist"

CURRENT=none
aws_ efs describe-file-system-policy --file-system-id "$EFS_FS" >/dev/null 2>&1 && CURRENT=present

if [ "$MODE" = rollback ]; then
  [ "$CURRENT" = present ] || { say 'no file system policy is attached; nothing to roll back'; exit 0; }
  [ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from.'
  printf 'This removes the policy and returns %s to allow-all. Type exactly: rollback %s\n> ' "$EFS_FS" "$EFS_FS"
  read -r ANSWER
  [ "$ANSWER" = "rollback $EFS_FS" ] || die 'aborted'
  run aws_ efs delete-file-system-policy --file-system-id "$EFS_FS"
  say "Removed the file system policy from $EFS_FS"
  exit 0
fi

AP_COUNT=$(aws_ efs describe-access-points --file-system-id "$EFS_FS" --query 'length(AccessPoints)' --output text)

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    Filesystem       $EFS_FS  ($AP_COUNT access points)
    Current policy   $CURRENT
    New policy       $POLICY
                     Deny  *  when elasticfilesystem:AccessPointArn is absent
                     Allow ClientMount / ClientWrite / ClientRootAccess when it is present

  What this changes: nothing, for any mount AgentCore performs - those are always scoped to
  the access point named in the runtime's filesystemConfigurations. What it stops is a root
  process inside any microVM mounting the filesystem root directly over NFS and reading every
  other user's workspace.

  Deliberately NOT included: a condition on aws:SecureTransport. It would require the client
  to mount with TLS, and whether AgentCore's managed mount does is unknown - adding it
  untested would break every runtime at once. Test it separately if you want it.

  Cost: nothing.

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
warn 'A wrong policy here breaks every mount on this filesystem. Rollback: sh infra/aws/harden-efs.sh --rollback'
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS. Type exactly: harden efs %s\n> ' "$EFS_FS"
read -r ANSWER
[ "$ANSWER" = "harden efs $EFS_FS" ] || die 'aborted'

run aws_ efs put-file-system-policy --file-system-id "$EFS_FS" --policy "file://$POLICY" >/dev/null
say "Attached the access-points-only policy to $EFS_FS"

cat <<DONE

> Attached. It is not proven until you have tried both halves.

Verify by trying - from a shell inside any provisioned cube:

  # 1. the legitimate mount must still work
  ls /mnt/workspace && touch /mnt/workspace/.policy-check && echo 'access point mount OK'

  # 2. the raw mount must now fail. Find a mount target address first:
  #    aws efs describe-mount-targets --region $REGION --file-system-id $EFS_FS \\
  #      --query 'MountTargets[].IpAddress' --output text
  mkdir -p /tmp/raw
  mount -t nfs4 -o nfsvers=4.1 <mount-target-ip>:/ /tmp/raw && ls /tmp/raw/workspaces

  If step 2 lists other users' directories, this policy did NOT close the gap and multi-user
  isolation is not real yet. Roll back, and treat per-user network isolation (a security
  group per runtime, and mount targets that only that group can reach) as the fallback.

  Run the same check from a second user's cube before and after. The before-state is worth
  recording: it is the difference between a measured control and a hopeful one.

Teardown:

  aws efs delete-file-system-policy --region $REGION --file-system-id $EFS_FS

DONE
