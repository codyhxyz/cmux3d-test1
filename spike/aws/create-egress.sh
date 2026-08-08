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
# NAT_MODE=instance t4g.nano NAT instance, ~$3/month. You own patching and its uptime.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
NAT_MODE="${CUBE_NAT_MODE:-gateway}"
NAME="${CUBE_EGRESS_NAME:-coding-cube}"
VPC="${CUBE_VPC:-}"
# Two AZs: EFS allows one mount target per AZ and AgentCore spreads its ENIs.
PRIVATE_CIDRS="${CUBE_PRIVATE_CIDRS:-172.31.200.0/24 172.31.201.0/24}"
AZS="${CUBE_AZS:-us-east-1a us-east-1b}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/../../infra/aws/aws-common.sh"
aws_common_parse_dry_run "$@"
aws_verify_account
[ "$NAT_MODE" = gateway ] || [ "$NAT_MODE" = instance ] || die "CUBE_NAT_MODE must be gateway or instance"

if [ -z "$VPC" ]; then
  VPC=$(aws_ ec2 describe-vpcs --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)
  [ "$VPC" != None ] || die 'no default VPC; set CUBE_VPC'
fi

# A public subnet to host the NAT itself.
PUBLIC_SUBNET=$(aws_ ec2 describe-subnets \
  --filters Name=vpc-id,Values="$VPC" Name=default-for-az,Values=true Name=availability-zone,Values="${AZS%% *}" \
  --query 'Subnets[0].SubnetId' --output text)
[ "$PUBLIC_SUBNET" != None ] || die "no default subnet in ${AZS%% *} to place the NAT in"

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    VPC              $VPC
    Private subnets  $PRIVATE_CIDRS  (in $AZS)
    NAT              $NAT_MODE, in $PUBLIC_SUBNET
    Route table      $NAME-private, 0.0.0.0/0 -> the NAT

  Recurring cost: $([ "$NAT_MODE" = gateway ] && echo '~$32.40/month + $0.045/GB processed' || echo '~$3/month (t4g.nano) + data')

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS and adds recurring cost. Type exactly: create egress %s\n> ' "$NAT_MODE"
read -r ANSWER
[ "$ANSWER" = "create egress $NAT_MODE" ] || die 'aborted'

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
if [ "$NAT_MODE" = gateway ]; then
  NAT=$(aws_ ec2 describe-nat-gateways --filter Name=vpc-id,Values="$VPC" Name=state,Values=available,pending \
    --query 'NatGateways[0].NatGatewayId' --output text 2>/dev/null || echo None)
  if [ "$NAT" = None ] || [ -z "$NAT" ]; then
    EIP=$(run aws_ ec2 allocate-address --domain vpc --query AllocationId --output text)
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
  ROUTE_TARGET="--nat-gateway-id $NAT"
else
  die 'NAT_MODE=instance is not implemented yet; use gateway, or set it up by hand and pass CUBE_ROUTE_TARGET'
fi

# ── route table ─────────────────────────────────────────────────────────────────
RTB=$(aws_ ec2 describe-route-tables --filters Name=vpc-id,Values="$VPC" Name=tag:Name,Values="$NAME-private" \
  --query 'RouteTables[0].RouteTableId' --output text 2>/dev/null || echo None)
if [ "$RTB" = None ] || [ -z "$RTB" ]; then
  RTB=$(run aws_ ec2 create-route-table --vpc-id "$VPC" \
    --tag-specifications "ResourceType=route-table,Tags=[{Key=Name,Value=$NAME-private}]" \
    --query RouteTable.RouteTableId --output text)
  say "Created route table $RTB"
fi
# Idempotent: replace if the route is already there, otherwise create it.
if aws_ ec2 describe-route-tables --route-table-ids "$RTB" \
  --query 'RouteTables[0].Routes[?DestinationCidrBlock==`0.0.0.0/0`]' --output text | grep -q .; then
  run aws_ ec2 replace-route --route-table-id "$RTB" --destination-cidr-block 0.0.0.0/0 $ROUTE_TARGET
else
  run aws_ ec2 create-route --route-table-id "$RTB" --destination-cidr-block 0.0.0.0/0 $ROUTE_TARGET >/dev/null
fi
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
  export CUBE_NAT=$NAT

  EFS mount targets must exist in these AZs too. Re-run create-efs.sh with
  CUBE_SUBNETS="$SUBNET_IDS" to add them.

Teardown - stops the recurring charge:

  aws ec2 delete-nat-gateway --region $REGION --nat-gateway-id $NAT
  # then release the Elastic IP it was using, or it keeps billing:
  aws ec2 describe-addresses --region $REGION --query 'Addresses[?AssociationId==null].AllocationId' --output text
  aws ec2 release-address --region $REGION --allocation-id <id>

DONE
