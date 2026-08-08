#!/bin/sh
# Private subnets + NAT for a VPC-mode agent runtime. EVERY STEP MUTATES AWS.
#
# Why this exists: AgentCore's service-managed ENIs do not get public IPs. Measured — a
# runtime placed in the default VPC's *public* subnets (MapPublicIpOnLaunch=true, IGW
# route) cannot pull its image and every invocation fails with 502 or a read timeout.
# An internet gateway only translates for an ENI that has a public IP, so "public subnet"
# is not enough. The runtime must sit in a private subnet whose default route is a NAT.
#
# requireServiceS3Endpoint would have covered the ECR/S3 half, but it cannot be set at
# create time and is immutable for agents created after 2026-06-11 — so it is not an
# option, and it would not have covered api.anthropic.com anyway.
#
# NAT_MODE=gateway  managed NAT Gateway, ~$32.40/month + $0.045/GB. Zero operations.
# NAT_MODE=instance t4g.nano NAT instance, ~$7.40/month all-in. You own patching and uptime.
#
# WHAT THE INSTANCE GIVES UP — read this before switching, because the private subnets have
# exactly one default route and everything in them loses the internet when it is wrong:
#
#   * No automatic failover. The managed gateway is redundant inside its AZ and AWS repairs
#     it without telling you. This is one EC2 instance: if it wedges, gets a bad kernel, or
#     its AZ has a bad day, EVERY cube loses egress until a human rebuilds it. There is no
#     second one, and this script does not build a standby.
#   * Bandwidth is capped by the instance type. A NAT gateway does up to 100 Gbps and never
#     throttles. t4g.nano is a *burstable* 2-vCPU box with 512 MB and up-to-5-Gbps networking
#     that it can only sustain in bursts; NAT is interrupt-heavy, so CPU credits are the real
#     ceiling. With CpuCredits=standard (the default here) a sustained transfer throttles
#     rather than surprising you with an unlimited-mode bill. conntrack is also bounded by
#     512 MB of RAM — fine for tens of cubes, not for thousands of connections each.
#   * It is a patchable box you now own. Kernel CVEs, the SSM agent, reboots, and the blast
#     radius of every one of those is "the cube has no internet". User-data turns on
#     dnf-automatic security updates and attaches AmazonSSMManagedInstanceCore so you can get
#     a shell without opening SSH, but nobody else is going to patch it for you.
#   * No NAT gateway CloudWatch metrics (BytesOutToDestination, ErrorPortAllocation, …). You
#     get EC2 metrics and whatever you scrape off the box.
#
# `--rollback` puts 0.0.0.0/0 back on a managed NAT gateway in one call. Reach for it the
# moment egress looks wrong; work out why afterwards.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
NAT_MODE="${CUBE_NAT_MODE:-gateway}"
NAME="${CUBE_EGRESS_NAME:-coding-cube}"
VPC="${CUBE_VPC:-}"
# Two AZs: EFS allows one mount target per AZ and AgentCore spreads its ENIs.
PRIVATE_CIDRS="${CUBE_PRIVATE_CIDRS:-172.31.200.0/24 172.31.201.0/24}"
AZS="${CUBE_AZS:-us-east-1a us-east-1b}"

# ── NAT instance knobs (ignored when NAT_MODE=gateway) ──────────────────────────
NAT_TYPE="${CUBE_NAT_INSTANCE_TYPE:-t4g.nano}"
# Resolved from SSM at run time, never hardcoded: a pinned AMI id silently becomes an
# unpatched AMI id, and this box is on the public internet by definition.
NAT_AMI_PARAM="${CUBE_NAT_AMI_PARAM:-/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64}"
# standard, not unlimited: a t4g.nano in unlimited mode bills $0.05/vCPU-hour past its
# credits, which would quietly undo the entire reason for doing this.
NAT_CREDITS="${CUBE_NAT_CPU_CREDITS:-standard}"
NAT_SG_NAME="${CUBE_NAT_SG_NAME:-$NAME-nat}"
NAT_ROLE="${CUBE_NAT_ROLE:-$NAME-nat}"
# The Name tag on the instance, its EIP and its root volume. This is how a re-run finds what
# it already built, so changing it strands the old one still holding the route.
NAT_TAG="${CUBE_NAT_TAG:-$NAME-nat}"
# Prove the box actually forwards before pointing the cube's only default route at it.
NAT_PROBE="${CUBE_NAT_PROBE:-1}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/../../infra/aws/aws-common.sh"

# aws_common_parse_dry_run only understands --dry-run, and this script has a second mode.
MODE=apply
DRY_RUN=0
for ARG in "$@"; do
  case "$ARG" in
    --dry-run|--plan) DRY_RUN=1 ;;
    --rollback) MODE=rollback ;;
    *) printf 'usage: %s [--dry-run] [--rollback]\n' "$0" >&2; exit 2 ;;
  esac
done

aws_verify_account
[ "$NAT_MODE" = gateway ] || [ "$NAT_MODE" = instance ] || die "CUBE_NAT_MODE must be gateway or instance"

# ── helpers shared by the apply and rollback paths ──────────────────────────────

# Whatever 0.0.0.0/0 resolves to today, whichever field carries it.
route_target_of() {
  aws_ ec2 describe-route-tables --route-table-ids "$1" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`].[NatGatewayId,NetworkInterfaceId,GatewayId,TransitGatewayId]' \
    --output text 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i != "None") { print $i; exit } }'
}

# Idempotent: replace if the route is already there, otherwise create it. Callers pass the
# target flags unquoted, e.g. `set_default_route "$RTB" --nat-gateway-id nat-…`.
set_default_route() {
  srt_rtb=$1
  shift
  if aws_ ec2 describe-route-tables --route-table-ids "$srt_rtb" \
    --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`]' --output text | grep -q .; then
    run aws_ ec2 replace-route --route-table-id "$srt_rtb" --destination-cidr-block 0.0.0.0/0 "$@"
  else
    run aws_ ec2 create-route --route-table-id "$srt_rtb" --destination-cidr-block 0.0.0.0/0 "$@" >/dev/null
  fi
}

# Sets NAT to an available managed NAT gateway in this VPC, building one if there is none.
ensure_nat_gateway() {
  NAT=$(aws_ ec2 describe-nat-gateways --filter Name=vpc-id,Values="$VPC" Name=state,Values=available,pending \
    --query 'NatGateways[0].NatGatewayId' --output text 2>/dev/null || echo None)
  if [ "$NAT" = None ] || [ -z "$NAT" ]; then
    EIP=$(run aws_ ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" \
      --query AllocationId --output text)
    NAT=$(run aws_ ec2 create-nat-gateway --subnet-id "$PUBLIC_SUBNET" --allocation-id "$EIP" \
      --tag-specifications "ResourceType=natgateway,Tags=[{Key=Name,Value=$NAME}]" \
      --query NatGateway.NatGatewayId --output text)
    say "Created NAT gateway $NAT"
    printf 'waiting for %s' "$NAT"
    while [ "$(aws_ ec2 describe-nat-gateways --nat-gateway-ids "$NAT" --query 'NatGateways[0].State' --output text)" != available ]; do
      printf '.'; sleep 5
    done
    printf '\n'
  else
    say "NAT gateway $NAT already exists"
  fi
}

confirm() {
  [ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
  printf '%s Type exactly: %s\n> ' "$1" "$2"
  read -r ANSWER
  [ "$ANSWER" = "$2" ] || die 'aborted'
}

# ── discovery (read only) ───────────────────────────────────────────────────────
if [ -z "$VPC" ]; then
  VPC=$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  [ "$VPC" != None ] || die 'no default VPC; set CUBE_VPC'
fi

# Every CIDR the VPC owns, so the NAT security group covers secondary ranges too.
VPC_CIDRS=$(aws_ ec2 describe-vpcs --vpc-ids "$VPC" \
  --query 'Vpcs[0].CidrBlockAssociationSet[?CidrBlockState.State==`associated`].CidrBlock' \
  --output text | tr '\t' ' ')
[ -n "$VPC_CIDRS" ] || die "could not read the CIDRs of $VPC"

# A public subnet to host the NAT itself.
PUBLIC_SUBNET=$(aws_ ec2 describe-subnets \
  --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true Name=availability-zone,Values="${AZS%% *}" \
  --query 'Subnets[0].SubnetId' --output text)
[ "$PUBLIC_SUBNET" != None ] || die "no default subnet in ${AZS%% *} to place the NAT in"

RTB=$(aws_ ec2 describe-route-tables --filters Name=vpc-id,Values="$VPC" Name=tag:Name,Values="$NAME-private" \
  --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || echo None)
CURRENT_TARGET=nothing
if [ "$RTB" != None ] && [ -n "$RTB" ]; then
  CURRENT_TARGET=$(route_target_of "$RTB")
  [ -n "$CURRENT_TARGET" ] || CURRENT_TARGET=nothing
fi

# ── rollback: back to the managed NAT gateway ───────────────────────────────────
# Deliberately does NOT terminate the NAT instance. Restoring egress is urgent; reclaiming
# $7/month is not, and keeping the instance around means you can look at why it failed.
if [ "$MODE" = rollback ]; then
  [ "$RTB" != None ] && [ -n "$RTB" ] \
    || die "no route table tagged $NAME-private in $VPC; there is nothing to roll back"
  EXISTING_GW=$(aws_ ec2 describe-nat-gateways --filter Name=vpc-id,Values="$VPC" Name=state,Values=available,pending \
    --query 'NatGateways[0].NatGatewayId' --output text 2>/dev/null || echo None)

  cat <<PLAN

  Rollback - account $ACCOUNT, region $REGION

    VPC              $VPC
    Route table      $RTB  ($NAME-private)
    0.0.0.0/0 now    $CURRENT_TARGET
    0.0.0.0/0 after  $([ "$EXISTING_GW" = None ] && echo 'a NEW managed NAT gateway (allocates an EIP)' || echo "$EXISTING_GW")

  This restores the paid, managed, no-operations path. Recurring cost goes back to
  ~\$32.40/month + \$0.045/GB processed.

  It does not touch the NAT instance. Terminate that yourself once egress is confirmed
  healthy - the commands are printed at the end.

PLAN

  [ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
  confirm 'This puts the cube back on the managed NAT gateway and its recurring charge.' 'rollback egress'

  ensure_nat_gateway
  set_default_route "$RTB" --nat-gateway-id "$NAT"
  say "0.0.0.0/0 in $RTB points at $NAT again"

  cat <<DONE

> Rolled back. Confirm from inside a cube before you believe it:

  curl -s -o /dev/null -w '%{http_code}\\n' https://api.anthropic.com/v1/messages   # expect 405
  curl -s -o /dev/null -w '%{http_code}\\n' https://registry.npmjs.org             # expect 200

DONE

  NAT_INSTANCE=$(aws_ ec2 describe-instances \
    --filters Name=tag:Name,Values="$NAT_TAG" Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)
  if [ "$NAT_INSTANCE" != None ] && [ -n "$NAT_INSTANCE" ]; then
    cat <<DONE
The NAT instance $NAT_INSTANCE is still running and still billing. Nothing routes through it
now. Keep it while you work out what went wrong, then:

  aws ec2 terminate-instances --region $REGION --instance-ids $NAT_INSTANCE
  aws ec2 release-address --region $REGION --allocation-id \\
    \$(aws ec2 describe-addresses --region $REGION --filters Name=tag:Name,Values=$NAT_TAG \\
      --query 'Addresses[0].AllocationId' --output text)
  aws ec2 delete-security-group --region $REGION --group-id \\
    \$(aws ec2 describe-security-groups --region $REGION --filters Name=vpc-id,Values=$VPC \\
      Name=group-name,Values=$NAT_SG_NAME --query 'SecurityGroups[0].GroupId' --output text)

DONE
  fi
  exit 0
fi

# ── plan ────────────────────────────────────────────────────────────────────────
if [ "$NAT_MODE" = instance ]; then
  AMI=$(aws_ ssm get-parameter --name "$NAT_AMI_PARAM" --query Parameter.Value --output text) \
    || die "could not resolve $NAT_AMI_PARAM from SSM Parameter Store"
  AMI_NAME=$(aws_ ec2 describe-images --image-ids "$AMI" --query 'Images[0].Name' --output text 2>/dev/null || echo unknown)
fi

# A function, not a variable: a heredoc this size inside $(...) trips bash's scanner on the
# first apostrophe or backtick in a comment, and it fails at run time, not at `sh -n`.
#
# Persisted two ways on purpose: sysctl.d survives reboot for ip_forward, and a oneshot unit
# re-applies MASQUERADE every boot. A systemd unit rather than iptables-services because it
# does not depend on that package existing in whatever AL2023 ships next.
emit_user_data() {
  cat <<'UD'
#!/bin/bash
# Coding Cube NAT instance. Managed by spike/aws/create-egress.sh - edits here are lost on
# the next replacement. Output lands in /var/log/cloud-init-output.log.
set -eux

# The Elastic IP is attached moments after run-instances returns, so the first dnf may race
# it. Retry rather than leave a box that boots but never forwards.
install_iptables() {
  command -v iptables >/dev/null 2>&1 && return 0
  dnf install -y iptables-nft || dnf install -y iptables
}
n=0
until install_iptables; do
  n=$((n + 1))
  [ "$n" -ge 10 ] && exit 1
  sleep 10
done

cat >/etc/sysctl.d/99-cube-nat.conf <<'SYSCTL'
net.ipv4.ip_forward = 1
# Traffic enters and leaves on the same ENI; without this the box helpfully tells clients
# to route around it with ICMP redirects, which they cannot do.
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
SYSCTL
sysctl --system

cat >/usr/local/sbin/cube-nat-up <<'NATUP'
#!/bin/sh
# Masquerade everything leaving on the default-route interface. Idempotent: -C first, so a
# manual `systemctl restart cube-nat` does not stack duplicate rules.
set -eu
IFACE=$(ip -o -4 route show default | awk '{ print $5; exit }')
[ -n "$IFACE" ] || exit 1
iptables -t nat -C POSTROUTING -o "$IFACE" -j MASQUERADE 2>/dev/null \
  || iptables -t nat -A POSTROUTING -o "$IFACE" -j MASQUERADE
iptables -P FORWARD ACCEPT
# 512 MB of RAM sizes the conntrack table far lower than a NAT wants. Only settable once
# nf_conntrack is loaded, which the nat table above guarantees.
sysctl -w net.netfilter.nf_conntrack_max=65536 >/dev/null 2>&1 || true
NATUP
chmod 0755 /usr/local/sbin/cube-nat-up

cat >/etc/systemd/system/cube-nat.service <<'UNIT'
[Unit]
Description=Coding Cube NAT (ip_forward + MASQUERADE)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/cube-nat-up

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now cube-nat.service

# This is a box you own now. Unattended security patching is the floor, not the ceiling.
dnf install -y dnf-automatic || true
sed -i 's/^upgrade_type *=.*/upgrade_type = security/; s/^apply_updates *=.*/apply_updates = yes/' \
  /etc/dnf/automatic.conf || true
systemctl enable --now dnf-automatic.timer || true
UD
}

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    VPC              $VPC  ($VPC_CIDRS)
    Private subnets  $PRIVATE_CIDRS  (in $AZS)
PLAN

if [ "$NAT_MODE" = instance ]; then
  cat <<PLAN
    NAT              $NAT_TYPE instance in $PUBLIC_SUBNET, with an Elastic IP
    AMI              $AMI  ($AMI_NAME)
                     resolved from $NAT_AMI_PARAM
    CPU credits      $NAT_CREDITS
    Security group   $NAT_SG_NAME
                     inbound: all protocols from $VPC_CIDRS, and nothing else.
                     No SSH from the internet, ever.
    Instance profile $NAT_ROLE
                     AmazonSSMManagedInstanceCore, so Session Manager is the way in.
    Source/dest chk  disabled - a NAT forwards packets not addressed to it, and EC2
                     drops exactly those until this is off
    Route table      $NAME-private, 0.0.0.0/0 -> the primary ENI of that instance
    Health gate      $([ "$NAT_PROBE" = 1 ] && echo 'SSM probe for ip_forward + MASQUERADE before the route flips' || echo 'DISABLED (CUBE_NAT_PROBE=0)')
PLAN
else
  cat <<PLAN
    NAT              managed NAT gateway in $PUBLIC_SUBNET
    Route table      $NAME-private, 0.0.0.0/0 -> the gateway
PLAN
fi

cat <<PLAN

  0.0.0.0/0 in $([ "$RTB" = None ] && echo 'a new private route table' || echo "$RTB") currently points at: $CURRENT_TARGET

  Recurring cost:

PLAN

if [ "$NAT_MODE" = instance ]; then
  cat <<'PLAN'
    t4g.nano                    $0.0042/hr   ~$3.07/month
    in-use public IPv4 (EIP)    $0.005/hr    ~$3.65/month
    8 GiB gp3 root                           ~$0.64/month
                                             ~$7.36/month, plus data transfer out

  The "~$3/month" this gets quoted at is the instance line only. Since Feb 2024 every public
  IPv4 address bills, including the managed gateway's - but the gateway rolls its own into
  the $32.40. So the honest comparison is ~$7.40 against ~$32.40: a 4.4x saving, and the
  instance additionally skips the gateway's $0.045/GB processing fee.

  The user-data this instance boots with:

PLAN
  emit_user_data | sed 's/^/      /'
  cat <<PLAN

  Every private subnet has exactly one default route. If this instance is wrong, every cube
  loses the internet at the moment the route flips. Recovery is one command:

    sh spike/aws/create-egress.sh --rollback

PLAN
else
  cat <<'PLAN'
    ~$32.40/month fixed + $0.045/GB processed. Zero operations.

  CUBE_NAT_MODE=instance does the same job on a t4g.nano for ~$7.40/month, at the cost of
  the failover, bandwidth and patching trade-offs documented at the top of this script.

PLAN
fi

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
confirm 'This mutates AWS and adds recurring cost.' "create egress $NAT_MODE"

# ── private subnets ─────────────────────────────────────────────────────────────
SUBNET_IDS=''
set -- $AZS
for CIDR in $PRIVATE_CIDRS; do
  AZ=$1; shift || true
  [ -n "${AZ:-}" ] || die 'more CIDRs than AZs'
  EXISTING=$(aws_ ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" Name=cidr-block,Values="$CIDR" \
    --query 'Subnets[0].SubnetId' --output text 2>/dev/null || echo None)
  if [ "$EXISTING" = None ] || [ -z "$EXISTING" ]; then
    EXISTING=$(run aws_ ec2 create-subnet --vpc-id "$VPC" --cidr-block "$CIDR" --availability-zone "$AZ" \
      --tag-specifications "ResourceType=subnet,Tags=[{Key=Name,Value=$NAME-private-$AZ}]" \
      --query Subnet.SubnetId --output text)
    say "Created private subnet $EXISTING ($CIDR in $AZ)"
  else
    say "Private subnet $EXISTING already exists ($CIDR)"
  fi
  SUBNET_IDS="$SUBNET_IDS $EXISTING"
done
SUBNET_IDS=$(echo "$SUBNET_IDS" | sed 's/^ //')

# ── NAT ─────────────────────────────────────────────────────────────────────────
NAT_INSTANCE=''
NAT_ENI=''
NAT_EIP=''
if [ "$NAT_MODE" = gateway ]; then
  ensure_nat_gateway
  ROUTE_TARGET="--nat-gateway-id $NAT"
else
  # -- security group: the VPC and nothing else --------------------------------
  # A NAT instance sees traffic *forwarded* from the private subnets, so the source address
  # is the original private IP and a VPC-CIDR rule is the whole story. Nothing on the public
  # internet has any business opening a connection to this box - management is Session
  # Manager, which is an outbound connection from the instance.
  NAT_SG=$(aws_ ec2 describe-security-groups --filters Name=vpc-id,Values="$VPC" Name=group-name,Values="$NAT_SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || echo None)
  if [ "$NAT_SG" = None ] || [ -z "$NAT_SG" ]; then
    NAT_SG=$(run aws_ ec2 create-security-group --vpc-id "$VPC" --group-name "$NAT_SG_NAME" \
      --description 'Coding Cube NAT instance: forwarded traffic from inside the VPC only' \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$NAT_SG_NAME}]" \
      --query GroupId --output text)
    say "Created security group $NAT_SG"
  else
    say "Security group $NAT_SG already exists"
  fi
  for CIDR in $VPC_CIDRS; do
    RULE=$(aws_ ec2 describe-security-group-rules --filters Name=group-id,Values="$NAT_SG" \
      --query "SecurityGroupRules[?IsEgress==\`false\` && CidrIpv4=='$CIDR'] | [0].SecurityGroupRuleId" \
      --output text 2>/dev/null || echo None)
    if [ "$RULE" = None ] || [ -z "$RULE" ]; then
      run aws_ ec2 authorize-security-group-ingress --group-id "$NAT_SG" \
        --ip-permissions "IpProtocol=-1,IpRanges=[{CidrIp=$CIDR,Description=$NAT_TAG-vpc-only}]" >/dev/null
      say "Allowed all protocols from $CIDR"
    else
      say "Ingress from $CIDR already allowed"
    fi
  done

  # -- instance profile: a way in that is not an open port ---------------------
  if aws iam get-role --role-name "$NAT_ROLE" >/dev/null 2>&1; then
    say "Role $NAT_ROLE already exists"
  else
    run aws iam create-role --role-name "$NAT_ROLE" \
      --description 'Coding Cube NAT instance. Session Manager only; the box has no inbound SSH.' \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    say "Created role $NAT_ROLE"
  fi
  run aws iam attach-role-policy --role-name "$NAT_ROLE" \
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  if ! aws iam get-instance-profile --instance-profile-name "$NAT_ROLE" >/dev/null 2>&1; then
    run aws iam create-instance-profile --instance-profile-name "$NAT_ROLE" >/dev/null
    say "Created instance profile $NAT_ROLE"
  fi
  if ! aws iam get-instance-profile --instance-profile-name "$NAT_ROLE" \
    --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null | grep -qw "$NAT_ROLE"; then
    run aws iam add-role-to-instance-profile --instance-profile-name "$NAT_ROLE" --role-name "$NAT_ROLE"
    say "Added $NAT_ROLE to instance profile $NAT_ROLE"
  fi

  # -- Elastic IP, allocated before the instance so it can be attached at once --
  NAT_EIP=$(aws_ ec2 describe-addresses --filters Name=tag:Name,Values="$NAT_TAG" \
    --query 'Addresses[0].AllocationId' --output text 2>/dev/null || echo None)
  if [ "$NAT_EIP" = None ] || [ -z "$NAT_EIP" ]; then
    NAT_EIP=$(run aws_ ec2 allocate-address --domain vpc \
      --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAT_TAG}]" \
      --query AllocationId --output text)
    say "Allocated Elastic IP $NAT_EIP"
  else
    say "Elastic IP $NAT_EIP already allocated"
  fi

  # -- the instance ------------------------------------------------------------
  NAT_INSTANCE=$(aws_ ec2 describe-instances \
    --filters Name=tag:Name,Values="$NAT_TAG" Name=instance-state-name,Values=pending,running,stopping,stopped \
    --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || echo None)

  if [ "$NAT_INSTANCE" = None ] || [ -z "$NAT_INSTANCE" ]; then
    TMPD=$(mktemp -d)
    trap 'rm -rf "$TMPD"' EXIT INT TERM
    emit_user_data >"$TMPD/user-data.sh"

    # IAM is eventually consistent: an instance profile created seconds ago fails
    # run-instances with "Invalid IAM Instance Profile name" for a while.
    ATTEMPT=0
    while :; do
      if LAUNCH=$(run aws_ ec2 run-instances \
        --image-id "$AMI" \
        --instance-type "$NAT_TYPE" \
        --subnet-id "$PUBLIC_SUBNET" \
        --security-group-ids "$NAT_SG" \
        --iam-instance-profile "Name=$NAT_ROLE" \
        --credit-specification "CpuCredits=$NAT_CREDITS" \
        --metadata-options 'HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1' \
        --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=8,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}' \
        --user-data "file://$TMPD/user-data.sh" \
        --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAT_TAG}]" \
                             "ResourceType=volume,Tags=[{Key=Name,Value=$NAT_TAG}]" \
        --query 'Instances[0].[InstanceId,NetworkInterfaces[0].NetworkInterfaceId]' --output text); then
        break
      fi
      ATTEMPT=$((ATTEMPT + 1))
      [ "$ATTEMPT" -lt 5 ] || die 'run-instances kept failing; nothing was routed at it, so egress is untouched'
      warn "run-instances failed (attempt $ATTEMPT); the instance profile may still be propagating. Retrying in 10s."
      sleep 10
    done
    NAT_INSTANCE=$(printf '%s' "$LAUNCH" | awk '{ print $1 }')
    NAT_ENI=$(printf '%s' "$LAUNCH" | awk '{ print $2 }')
    say "Launched $NAT_INSTANCE ($NAT_TYPE, ENI $NAT_ENI)"
  else
    say "NAT instance $NAT_INSTANCE already exists"
    STATE=$(aws_ ec2 describe-instances --instance-ids "$NAT_INSTANCE" \
      --query 'Reservations[0].Instances[0].State.Name' --output text)
    case "$STATE" in
      stopped) run aws_ ec2 start-instances --instance-ids "$NAT_INSTANCE" >/dev/null; say "Starting $NAT_INSTANCE" ;;
      stopping) die "$NAT_INSTANCE is stopping; wait for it to reach stopped, then re-run" ;;
    esac
    NAT_ENI=$(aws_ ec2 describe-instances --instance-ids "$NAT_INSTANCE" \
      --query 'Reservations[0].Instances[0].NetworkInterfaces[0].NetworkInterfaceId' --output text)
  fi

  # A NAT forwards packets whose destination is not itself, and EC2 drops exactly those
  # unless source/dest checking is off. This is the single most common way a hand-built NAT
  # instance "works" right up until you route traffic at it.
  run aws_ ec2 modify-instance-attribute --instance-id "$NAT_INSTANCE" --no-source-dest-check
  say "Source/dest check disabled on $NAT_INSTANCE"

  # Measured, on the first real run: AssociateAddress fails with IncorrectInstanceState while
  # the instance is `pending` — "the pending-instance-running instance ... is not in a valid
  # state for this operation". The comment this replaces claimed allocating the EIP before
  # run-instances meant it could attach during pending. It cannot. Wait for `running` first.
  if [ "$DRY_RUN" != 1 ]; then
    say "Waiting for $NAT_INSTANCE to reach running before attaching the Elastic IP"
    aws_ ec2 wait instance-running --instance-ids "$NAT_INSTANCE"
  fi

  ASSOC_ENI=$(aws_ ec2 describe-addresses --allocation-ids "$NAT_EIP" \
    --query 'Addresses[0].NetworkInterfaceId' --output text 2>/dev/null || echo None)
  if [ "$ASSOC_ENI" = "$NAT_ENI" ]; then
    say "Elastic IP $NAT_EIP already on $NAT_ENI"
  else
    run aws_ ec2 associate-address --allocation-id "$NAT_EIP" --network-interface-id "$NAT_ENI" \
      --allow-reassociation >/dev/null
    say "Associated Elastic IP $NAT_EIP with $NAT_ENI"
  fi
  NAT_IP=$(aws_ ec2 describe-addresses --allocation-ids "$NAT_EIP" --query 'Addresses[0].PublicIp' --output text)

  printf 'waiting for %s to run' "$NAT_INSTANCE"
  while [ "$(aws_ ec2 describe-instances --instance-ids "$NAT_INSTANCE" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)" != running ]; do
    printf '.'; sleep 5
  done
  printf '\n'

  printf 'waiting for both status checks on %s' "$NAT_INSTANCE"
  while :; do
    CHECKS=$(aws_ ec2 describe-instance-status --instance-ids "$NAT_INSTANCE" \
      --query 'InstanceStatuses[0].[InstanceStatus.Status,SystemStatus.Status]' --output text 2>/dev/null | tr '\t' '/')
    if [ "$CHECKS" = ok/ok ]; then break; fi
    printf '.'; sleep 10
  done
  printf '\n'

  # -- health gate -------------------------------------------------------------
  # Status checks say the hypervisor is happy; they say nothing about whether cloud-init
  # finished or MASQUERADE exists. Ask the box directly, over Session Manager, before the
  # private subnets' only default route is pointed at it.
  PROBE_OK=0
  if [ "$NAT_PROBE" = 1 ]; then
    printf 'waiting for %s to register with SSM' "$NAT_INSTANCE"
    N=0
    while [ "$N" -lt 36 ]; do
      PING=$(aws_ ssm describe-instance-information --filters "Key=InstanceIds,Values=$NAT_INSTANCE" \
        --query 'InstanceInformationList[0].PingStatus' --output text 2>/dev/null || echo None)
      if [ "$PING" = Online ]; then break; fi
      printf '.'; N=$((N + 1)); sleep 10
    done
    printf '\n'

    if [ "${PING:-None}" = Online ]; then
      [ -n "${TMPD:-}" ] || { TMPD=$(mktemp -d); trap 'rm -rf "$TMPD"' EXIT INT TERM; }
      # Each check exits non-zero on its own, so a Failed invocation is a real answer rather
      # than a timeout. is-enabled is in here because reboot survival is a requirement, and
      # a MASQUERADE rule that only exists in RAM looks identical until the box restarts.
      cat >"$TMPD/probe.json" <<'PROBE'
{"commands":["cloud-init status --wait >/dev/null 2>&1 || true","[ \"$(sysctl -n net.ipv4.ip_forward)\" = 1 ] || { echo 'ip_forward is off'; exit 1; }","iptables -t nat -S POSTROUTING | grep -q MASQUERADE || { echo 'no MASQUERADE rule'; exit 1; }","systemctl is-enabled cube-nat.service >/dev/null || { echo 'cube-nat.service is not enabled; NAT would not survive a reboot'; exit 1; }","echo NAT_READY"]}
PROBE
      CMD=$(run aws_ ssm send-command --instance-ids "$NAT_INSTANCE" \
        --document-name AWS-RunShellScript --parameters "file://$TMPD/probe.json" \
        --query Command.CommandId --output text) || CMD=''
      if [ -n "$CMD" ]; then
        printf 'probing %s' "$NAT_INSTANCE"
        N=0
        # 5 minutes: cloud-init installs three packages before any of this is true.
        while [ "$N" -lt 60 ]; do
          STATUS=$(aws_ ssm get-command-invocation --command-id "$CMD" --instance-id "$NAT_INSTANCE" \
            --query Status --output text 2>/dev/null || echo Pending)
          case "$STATUS" in
            Success) PROBE_OK=1; break ;;
            Failed|Cancelled|TimedOut|Undeliverable|Terminated) break ;;
          esac
          printf '.'; N=$((N + 1)); sleep 5
        done
        printf '\n'
        if [ "$PROBE_OK" = 0 ]; then
          WHY=$(aws_ ssm get-command-invocation --command-id "$CMD" --instance-id "$NAT_INSTANCE" \
            --query '[StandardOutputContent,StandardErrorContent]' --output text 2>/dev/null || true)
          warn "probe said: ${WHY:-nothing}"
        fi
      fi
    fi

    if [ "$PROBE_OK" = 1 ]; then
      say "$NAT_INSTANCE forwards: ip_forward on, MASQUERADE present, cube-nat enabled"
    else
      warn "Could not prove $NAT_INSTANCE forwards traffic. Flipping the route now may take"
      warn 'every cube offline. Check /var/log/cloud-init-output.log over Session Manager first:'
      warn "  aws ssm start-session --region $REGION --target $NAT_INSTANCE"
      confirm 'Point the private subnets at an unverified NAT anyway?' 'flip anyway'
    fi
  fi

  ROUTE_TARGET="--network-interface-id $NAT_ENI"
fi

# ── route table ─────────────────────────────────────────────────────────────────
if [ "$RTB" = None ] || [ -z "$RTB" ]; then
  RTB=$(run aws_ ec2 create-route-table --vpc-id "$VPC" \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=$NAME-private}]" \
    --query RouteTable.RouteTableId --output text)
  say "Created route table $RTB"
fi
set_default_route "$RTB" $ROUTE_TARGET
say 'Default route points at the NAT'

for SUBNET in $SUBNET_IDS; do
  ASSOC=$(aws_ ec2 describe-route-tables --route-table-ids "$RTB" \
    --query "RouteTables[0].Associations[?SubnetId=='$SUBNET'].RouteTableAssociationId | [0]" --output text)
  if [ "$ASSOC" = None ] || [ -z "$ASSOC" ]; then
    run aws_ ec2 associate-route-table --route-table-id "$RTB" --subnet-id "$SUBNET" --query AssociationId --output text >/dev/null
    say "Associated $SUBNET with $RTB"
  else
    say "$SUBNET already associated"
  fi
done

SUBNET_JSON=$(printf '%s' "$SUBNET_IDS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)

cat <<DONE

> Ready.

  export CUBE_PRIVATE_SUBNETS='[$SUBNET_JSON]'
DONE

if [ "$NAT_MODE" = gateway ]; then
  cat <<DONE
  export CUBE_NAT=$NAT
DONE
else
  cat <<DONE
  export CUBE_NAT_INSTANCE=$NAT_INSTANCE
  export CUBE_NAT_ENI=$NAT_ENI
  export CUBE_NAT_EIP=$NAT_EIP        # $NAT_IP
DONE
fi

cat <<DONE

  EFS mount targets must exist in these AZs too. Re-run create-efs.sh with
  CUBE_SUBNETS="$SUBNET_IDS" to add them.

DONE

if [ "$NAT_MODE" = instance ]; then
  OLD_GW=$(aws_ ec2 describe-nat-gateways --filter Name=vpc-id,Values="$VPC" Name=state,Values=available,pending \
    --query 'NatGateways[0].NatGatewayId' --output text 2>/dev/null || echo None)

  cat <<DONE
Verify before you walk away - from a shell inside any provisioned cube:

  curl -s -o /dev/null -w 'anthropic=%{http_code} %{time_total}s\\n' https://api.anthropic.com/v1/messages
  curl -s -o /dev/null -w 'github=%{http_code}\\n'  https://github.com
  curl -s -o /dev/null -w 'npm=%{http_code}\\n'     https://registry.npmjs.org

  405 from api.anthropic.com is the correct answer to a bare GET - it means you reached it.

If any of that fails, do not debug it with the cube offline:

  sh spike/aws/create-egress.sh --rollback

DONE

  if [ "$OLD_GW" != None ] && [ -n "$OLD_GW" ]; then
    cat <<DONE
!! The managed NAT gateway $OLD_GW is still running and still billing ~\$32.40/month.
   Nothing routes through it any more, so you are currently paying for both. The saving is
   not real until you delete it - but leave it up until the instance has proven itself for
   a day, because it is what --rollback reuses.

  aws ec2 delete-nat-gateway --region $REGION --nat-gateway-id $OLD_GW
  # then release its Elastic IP, or it keeps billing:
  aws ec2 describe-addresses --region $REGION --query 'Addresses[?AssociationId==null].AllocationId' --output text
  aws ec2 release-address --region $REGION --allocation-id <id>

DONE
  fi

  cat <<DONE
Teardown - stops the recurring charge, and takes the cube's internet with it. Move the route
off the instance FIRST or you leave a blackhole route behind and no egress at all:

  sh spike/aws/create-egress.sh --rollback      # or point 0.0.0.0/0 somewhere else yourself
  aws ec2 terminate-instances --region $REGION --instance-ids $NAT_INSTANCE
  aws ec2 release-address --region $REGION --allocation-id $NAT_EIP
  # the group will not delete until the terminated instance releases its ENI (~a minute)
  aws ec2 delete-security-group --region $REGION --group-id $NAT_SG
  aws iam remove-role-from-instance-profile --instance-profile-name $NAT_ROLE --role-name $NAT_ROLE
  aws iam delete-instance-profile --instance-profile-name $NAT_ROLE
  aws iam detach-role-policy --role-name $NAT_ROLE \\
    --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam delete-role --role-name $NAT_ROLE

DONE
else
  cat <<DONE
Teardown - stops the recurring charge:

  aws ec2 delete-nat-gateway --region $REGION --nat-gateway-id $NAT
  # then release the Elastic IP it was using, or it keeps billing:
  aws ec2 describe-addresses --region $REGION --query 'Addresses[?AssociationId==null].AllocationId' --output text
  aws ec2 release-address --region $REGION --allocation-id <id>

DONE
fi
