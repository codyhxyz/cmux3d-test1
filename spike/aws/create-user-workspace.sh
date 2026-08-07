#!/bin/sh
# Provisions ONE user: an EFS access point, an execution role, an agent runtime, and the
# registry row that ties them to a Cognito sub. EVERY STEP MUTATES AWS. Re-running is safe.
#
# Why a whole agent runtime per user, when one runtime provably serves twelve shells across
# two sessions: EFS access points are SHARED across a runtime's sessions. Measured in
# spike/RESULTS.md (T-13) - session B read session A's file. Storage binds at
# CreateAgentRuntime time and InvokeAgentRuntime has no per-invocation filesystem parameter,
# so the only place a different access point can be selected is a different runtime. One
# runtime per user is not caution; it is the only shape the API permits.
#
# What that buys: the per-user execution role can mount only through the per-user access
# point (elasticfilesystem:AccessPointArn condition), so isolation is enforced by IAM rather
# than by everyone remembering to pass the right path.
#
# What it costs: agent runtimes are capped at 100 per account (adjustable) and
# CreateAgentRuntime is 5/sec. That cap is the ceiling on registered users, and it is the
# first thing to raise before a real launch.
#
# Everything shared is reused, never recreated: the VPC, the NAT, the security group, the
# filesystem and the container image all come from spike/aws/create-egress.sh,
# spike/aws/create-efs.sh and spike/finch.sh.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"

# -- who ------------------------------------------------------------------------
# Either the Cognito sub directly, or an email this script resolves to one.
USER_ID="${CUBE_USER_ID:-}"
USER_EMAIL="${CUBE_USER_EMAIL:-}"
USER_POOL_ID="${CUBE_USER_POOL_ID:-}"
WORKSPACE_ID="${CUBE_WORKSPACE_ID:-default}"
TABLE="${CUBE_TABLE:-coding-cube-workspaces}"

# -- shared infrastructure (must already exist) ---------------------------------
EFS_FS="${CUBE_EFS_FS:-fs-01bc1a8b94bd929b7}"
SG="${CUBE_SG:-sg-04920fbdf335015cd}"
SUBNETS="${CUBE_SUBNETS:-subnet-00bc3910d37f32585 subnet-05ee6096f07cf52ed}"
ECR_REPO="${CUBE_ECR_REPO:-coding-cube-spike}"
IMAGE_TAG="${CUBE_IMAGE_TAG:-v2}"
MOUNT_PATH="${CUBE_MOUNT_PATH:-/mnt/workspace}"
# One level under the shared access point's root, which create-efs.sh put at /workspaces
# precisely so this would nest rather than migrate.
AP_ROOT_PREFIX="${CUBE_AP_ROOT_PREFIX:-/workspaces}"
# The container runs as uid 0 on the live platform, so the access point must present files
# as root or every write lands owned by someone the container cannot be. 0700, not 0755:
# this directory has exactly one legitimate reader.
AP_UID="${CUBE_AP_UID:-0}"
AP_GID="${CUBE_AP_GID:-0}"

# -- lifecycle ------------------------------------------------------------------
# Not the spike's 60/3600. 900 seconds of idle is long enough that a coffee break does not
# destroy live PIDs (files and herdr state survive regardless) and short enough that an
# abandoned tab stops billing within a quarter hour. maxLifetime is the ceiling on a stuck
# session: 8 hours at ~$0.22/hour is ~$1.76 of worst case per user per incident.
IDLE_TIMEOUT="${CUBE_IDLE_TIMEOUT:-900}"
MAX_LIFETIME="${CUBE_MAX_LIFETIME:-28800}"
# Refuse to consume the last of the runtime quota by accident.
AGENT_QUOTA="${CUBE_AGENT_QUOTA:-100}"
QUOTA_HEADROOM="${CUBE_QUOTA_HEADROOM:-5}"

MIN_CLI="2.34.16"
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG"

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
aws_() { aws --region "$REGION" "$@"; }

version_ge() {
  awk -v have="$1" -v want="$2" '
    function num(v,  p) { split(v, p, "."); return p[1] * 1000000 + p[2] * 1000 + p[3] }
    BEGIN { exit !(num(have) >= num(want)) }
  '
}

# ------------------------------------------------------------------- preflight --

command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
CLI_VERSION=$(aws --version 2>&1 | sed -n 's|^aws-cli/\([0-9][0-9.]*\).*|\1|p')
[ -n "$CLI_VERSION" ] || die 'could not read a version out of `aws --version`'
version_ge "$CLI_VERSION" "$MIN_CLI" \
  || die "AWS CLI $CLI_VERSION cannot express --filesystem-configurations; $MIN_CLI or newer is required"

CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'no usable AWS credentials'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "credentials are for account $CALLER but this script targets $ACCOUNT"

[ -f "$HERE/runtime-trust.json" ] || die "missing $HERE/runtime-trust.json"
grep -qF "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT:runtime/" "$HERE/runtime-trust.json" \
  || die "runtime-trust.json does not trust AgentCore in $REGION for account $ACCOUNT"

if [ -z "$USER_ID" ]; then
  [ -n "$USER_EMAIL" ] || die 'set CUBE_USER_ID (a Cognito sub) or CUBE_USER_EMAIL'
  [ -n "$USER_POOL_ID" ] || die 'CUBE_USER_POOL_ID is required to resolve CUBE_USER_EMAIL to a sub'
  USER_ID=$(aws_ cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$USER_EMAIL" \
    --query "UserAttributes[?Name=='sub'].Value | [0]" --output text 2>/dev/null || echo None)
  [ "$USER_ID" != 'None' ] && [ -n "$USER_ID" ] \
    || die "no user $USER_EMAIL in pool $USER_POOL_ID. Invite them first with admin-create-user."
  say "Resolved $USER_EMAIL to sub $USER_ID"
fi

# The sub is what everything downstream is named after, so it has to be exactly a UUID -
# anything else silently produces a runtime name that fails validation halfway through.
printf '%s' "$USER_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' \
  || die "CUBE_USER_ID '$USER_ID' is not a Cognito sub (a UUID)"
printf '%s' "$WORKSPACE_ID" | grep -Eq '^[a-z0-9][a-z0-9-]{0,63}$' \
  || die "CUBE_WORKSPACE_ID '$WORKSPACE_ID' must match [a-z0-9][a-z0-9-]{0,63}"

# agentRuntimeName is [a-zA-Z][a-zA-Z0-9_]{0,47} and rejects hyphens outright, so the sub's
# hyphens become underscores. cube_u_ (7) + a UUID (36) is 43 characters.
SLUG=$(printf '%s' "$USER_ID" | tr 'A-Z-' 'a-z_')
RUNTIME_NAME="cube_u_$SLUG"
printf '%s' "$RUNTIME_NAME" | grep -Eq '^[a-zA-Z][a-zA-Z0-9_]{0,47}$' \
  || die "derived agentRuntimeName '$RUNTIME_NAME' does not match [a-zA-Z][a-zA-Z0-9_]{0,47}"
# infra/policies/mint-policy.json scopes the Lambda to runtime/cube_u_*. A runtime named
# outside that prefix is invisible to the mint endpoint, which reads as a 403 at connect.
case "$RUNTIME_NAME" in cube_u_*) ;; *) die "runtime name must start with cube_u_ or the mint Lambda cannot invoke it" ;; esac

ROLE_NAME="CodingCubeWs-$USER_ID"
AP_NAME="cube-ws-$USER_ID"
AP_ROOT="$AP_ROOT_PREFIX/$USER_ID"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE_NAME"

# A missing prerequisite is fatal to a real run but must not stop --dry-run printing a plan;
# the whole point of the plan is to read it before anything exists.
need() { if [ "$DRY_RUN" = 1 ]; then warn "$1"; else die "$1"; fi; }

aws_ efs describe-file-systems --file-system-id "$EFS_FS" >/dev/null 2>&1 \
  || need "filesystem $EFS_FS does not exist. Run spike/aws/create-efs.sh first."
aws_ ec2 describe-security-groups --group-ids "$SG" >/dev/null 2>&1 \
  || need "security group $SG does not exist. Run spike/aws/create-efs.sh first."
aws_ ecr describe-images --repository-name "$ECR_REPO" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1 \
  || need "$IMAGE_URI is not in ECR. Push it with spike/finch.sh push."
aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1 \
  || need "table $TABLE does not exist. Run infra/aws/create-workspace-table.sh first."

AGENT_COUNT=$(aws_ bedrock-agentcore-control list-agent-runtimes --query 'length(agentRuntimes)' --output text 2>/dev/null || echo 0)
[ "$AGENT_COUNT" -lt "$((AGENT_QUOTA - QUOTA_HEADROOM))" ] \
  || need "there are $AGENT_COUNT agent runtimes against a quota of $AGENT_QUOTA. Raise the quota (Service Quotas: 'Total Agents per Account') before adding users."

# -------------------------------------------------------------------- survey --

AP=$(aws_ efs describe-access-points --file-system-id "$EFS_FS" \
  --query "AccessPoints[?Name=='$AP_NAME'].AccessPointId | [0]" --output text 2>/dev/null || echo None)
[ "$AP" = 'None' ] && AP=''
ROLE_EXISTS=0
aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 && ROLE_EXISTS=1
RUNTIME_ID=$(aws_ bedrock-agentcore-control list-agent-runtimes \
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text 2>/dev/null || echo None)
[ "$RUNTIME_ID" = 'None' ] && RUNTIME_ID=''

SUBNET_JSON=$(printf '%s' "$SUBNETS" | tr ' ' '\n' | sed 's/.*/"&"/' | paste -sd, -)

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    User             $USER_ID${USER_EMAIL:+  ($USER_EMAIL)}
    Workspace        $WORKSPACE_ID
    Access point     $AP_NAME  root $AP_ROOT  uid=$AP_UID gid=$AP_GID mode 0700   $([ -n "$AP" ] && echo "exists as $AP, skip" || echo CREATE)
    Execution role   $ROLE_NAME   $([ "$ROLE_EXISTS" = 1 ] && echo 'exists, policy overwritten' || echo CREATE)
    Agent runtime    $RUNTIME_NAME   $([ -n "$RUNTIME_ID" ] && echo "exists as $RUNTIME_ID, skip" || echo CREATE)
    Registry row     $TABLE  ($USER_ID / $WORKSPACE_ID)

  Reused, not created:
    filesystem $EFS_FS   security group $SG
    subnets    $SUBNETS
    image      $IMAGE_URI

  Runtime quota: $AGENT_COUNT of $AGENT_QUOTA agents in use.
  Lifecycle:     idle ${IDLE_TIMEOUT}s, maxLifetime ${MAX_LIFETIME}s.

  Cost: about \$0.22/hour while this user's cube is awake (2 vCPU + 4 GB, and memory is
  billed for the whole session including idle time), plus EFS at ~\$0.30/GB-month for what
  they store. Nothing above has a standing charge - the NAT gateway's ~\$32.40/month is
  shared across every user and is already paid for.

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS and consumes one of %s agent runtimes. Type exactly: provision %s\n> ' "$AGENT_QUOTA" "$USER_ID"
read -r ANSWER
[ "$ANSWER" = "provision $USER_ID" ] || die 'aborted'

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT INT TERM

# ------------------------------------------------------------- access point --

if [ -z "$AP" ]; then
  AP=$(run aws_ efs create-access-point --file-system-id "$EFS_FS" \
    --tags "Key=Name,Value=$AP_NAME" "Key=CodingCubeUser,Value=$USER_ID" "Key=CodingCubeWorkspace,Value=$WORKSPACE_ID" \
    --posix-user "Uid=$AP_UID,Gid=$AP_GID" \
    --root-directory "Path=$AP_ROOT,CreationInfo={OwnerUid=$AP_UID,OwnerGid=$AP_GID,Permissions=0700}" \
    --query AccessPointId --output text)
  say "Created access point $AP rooted at $AP_ROOT"
else
  say "Access point $AP_NAME already exists as $AP"
fi

printf 'waiting for %s to become available' "$AP"
while [ "$(aws_ efs describe-access-points --access-point-id "$AP" \
  --query 'AccessPoints[0].LifeCycleState' --output text)" != 'available' ]; do
  printf '.'; sleep 3
done
printf '\n'

AP_ARN="arn:aws:elasticfilesystem:$REGION:$ACCOUNT:access-point/$AP"
FS_ARN="arn:aws:elasticfilesystem:$REGION:$ACCOUNT:file-system/$EFS_FS"

# -------------------------------------------------------------- execution role --

# One role per user, and the reason is the single Condition below. A shared role would need
# elasticfilesystem:AccessPointArn to name every access point (or a wildcard), at which point
# any user's runtime could mount any user's workspace and the isolation is a convention
# rather than a control. The role is also readable from inside the microVM via MMDS, so it
# holds nothing beyond what that user's own container legitimately needs.
cat > "$STAGING/policy.json" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PullTheSharedImageAndNothingElse",
      "Effect": "Allow",
      "Action": ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
      "Resource": "arn:aws:ecr:$REGION:$ACCOUNT:repository/$ECR_REPO"
    },
    {
      "Sid": "EcrAuthTokenCannotBeResourceScopedSoScopeItByRegion",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "$REGION" } }
    },
    {
      "Sid": "RuntimeLogGroup",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:DescribeLogStreams"],
      "Resource": "arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/bedrock-agentcore/runtimes/$RUNTIME_NAME-*"
    },
    {
      "Sid": "RuntimeLogStreams",
      "Effect": "Allow",
      "Action": ["logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/bedrock-agentcore/runtimes/$RUNTIME_NAME-*:log-stream:*"
    },
    {
      "Sid": "DescribeTheEfsMountBeforeAttachingIt",
      "Effect": "Allow",
      "Action": ["elasticfilesystem:DescribeAccessPoints", "elasticfilesystem:DescribeMountTargets"],
      "Resource": ["$AP_ARN", "$FS_ARN"]
    },
    {
      "Sid": "MountOnlyThroughThisUsersAccessPoint",
      "Effect": "Allow",
      "Action": ["elasticfilesystem:ClientMount", "elasticfilesystem:ClientWrite", "elasticfilesystem:ClientRootAccess"],
      "Resource": "$FS_ARN",
      "Condition": { "StringEquals": { "elasticfilesystem:AccessPointArn": "$AP_ARN" } }
    }
  ]
}
POLICY

if [ "$ROLE_EXISTS" = 0 ]; then
  run aws iam create-role --role-name "$ROLE_NAME" \
    --description "Coding Cube workspace for Cognito sub $USER_ID. Readable from inside the microVM via MMDS." \
    --tags "Key=CodingCubeUser,Value=$USER_ID" \
    --assume-role-policy-document "file://$HERE/runtime-trust.json" >/dev/null
  say "Created role $ROLE_NAME"
fi
run aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name inline \
  --policy-document "file://$STAGING/policy.json"
say 'Inline policy written - this role can mount only through this access point'

# ------------------------------------------------------------------- runtime --

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"$IMAGE_URI\"}}"
NETWORK="{\"networkMode\":\"VPC\",\"networkModeConfig\":{\"subnets\":[$SUBNET_JSON],\"securityGroups\":[\"$SG\"]}}"
PROTOCOL='{"serverProtocol":"HTTP"}'
LIFECYCLE="{\"idleRuntimeSessionTimeout\":$IDLE_TIMEOUT,\"maxLifetime\":$MAX_LIFETIME}"
FILESYSTEM="[{\"efsAccessPoint\":{\"accessPointArn\":\"$AP_ARN\",\"mountPath\":\"$MOUNT_PATH\"}}]"
METADATA='{"requireMMDSV2":true}'
# HOME is load-bearing: herdr ignores HERDR_SOCKET_PATH whenever --session is passed, so the
# socket path is $HOME-derived, and the platform gives a spawned shell HOME=/root rather than
# the image's. Without this pinning every face looks for a socket that is not there.
ENVIRONMENT="{\"CODING_CUBE_SPIKE\":\"1\",\"CODING_CUBE_GATEWAY_ONLY\":\"1\",\"CODING_CUBE_MOUNT\":\"$MOUNT_PATH\",\"CODING_CUBE_WORKDIR\":\"$MOUNT_PATH/work\",\"CODING_CUBE_USER\":\"$USER_ID\",\"HOME\":\"/home/cube\",\"HERDR_SOCKET_PATH\":\"/home/cube/.config/herdr/herdr.sock\"}"

wait_ready() {
  attempt=0
  while [ "$attempt" -lt 60 ]; do
    state=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" --query status --output text 2>/dev/null || echo UNKNOWN)
    case "$state" in
      READY) return 0 ;;
      CREATE_FAILED|UPDATE_FAILED)
        reason=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" --query failureReason --output text 2>/dev/null || true)
        die "runtime $1 is $state ($reason)"
        ;;
      DELETING) die "runtime $1 is DELETING; wait for it to disappear, then re-run" ;;
    esac
    attempt=$((attempt + 1))
    sleep 5
  done
  die "runtime $1 never reached READY"
}

if [ -z "$RUNTIME_ID" ]; then
  ATTEMPT=0
  while :; do
    # IAM is eventually consistent, so a role created seconds ago may not be assumable yet -
    # which surfaces as a create-agent-runtime failure, not an IAM one.
    if RUNTIME_ID=$(run aws_ bedrock-agentcore-control create-agent-runtime \
      --agent-runtime-name "$RUNTIME_NAME" \
      --agent-runtime-artifact "$ARTIFACT" \
      --role-arn "$ROLE_ARN" \
      --network-configuration "$NETWORK" \
      --protocol-configuration "$PROTOCOL" \
      --lifecycle-configuration "$LIFECYCLE" \
      --filesystem-configurations "$FILESYSTEM" \
      --environment-variables "$ENVIRONMENT" \
      --query agentRuntimeId --output text); then break; fi
    RUNTIME_ID=''
    ATTEMPT=$((ATTEMPT + 1))
    [ "$ATTEMPT" -lt 5 ] || die 'create-agent-runtime kept failing'
    warn "create-agent-runtime failed (attempt $ATTEMPT); IAM may still be propagating. Retrying in 10s."
    sleep 10
  done
  say "Created runtime $RUNTIME_ID"
  wait_ready "$RUNTIME_ID"
else
  say "Runtime $RUNTIME_NAME already exists as $RUNTIME_ID"
fi

# requireMMDSV2 is not a member of CreateAgentRuntime; it exists only on UpdateAgentRuntime,
# which is a full replace, hence every field goes back in. Without it interactive shells are
# rejected outright. It now defaults to true on new runtimes, so this is usually a no-op -
# read it back rather than assume either way.
MMDS=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --query 'metadataConfiguration.requireMMDSV2' --output text 2>/dev/null || echo None)
if [ "$MMDS" != 'True' ]; then
  run aws_ bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration "$NETWORK" \
    --protocol-configuration "$PROTOCOL" \
    --lifecycle-configuration "$LIFECYCLE" \
    --filesystem-configurations "$FILESYSTEM" \
    --environment-variables "$ENVIRONMENT" \
    --metadata-configuration "$METADATA" >/dev/null
  say 'Enabled MMDSv2'
  wait_ready "$RUNTIME_ID"
else
  say 'MMDSv2 already enabled'
fi

RUNTIME_ARN=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --query agentRuntimeArn --output text)
MOUNTED=$(aws_ bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$RUNTIME_ID" \
  --query 'filesystemConfigurations[0].efsAccessPoint.accessPointArn' --output text)
[ "$MOUNTED" = "$AP_ARN" ] \
  || die "runtime $RUNTIME_ID mounts $MOUNTED, not this user's access point $AP_ARN. Refusing to register it."

# ------------------------------------------------------------- registry row --

NOW=$(date +%s)000
cat > "$STAGING/item.json" <<ITEM
{
  "user_id":          { "S": "$USER_ID" },
  "workspace_id":     { "S": "$WORKSPACE_ID" },
  "runtime_arn":      { "S": "$RUNTIME_ARN" },
  "access_point_arn": { "S": "$AP_ARN" },
  "role_arn":         { "S": "$ROLE_ARN" },
  "status":           { "S": "ready" },
  "created_at":       { "N": "$NOW" }
}
ITEM

# Conditional so a re-run cannot silently discard runtime_session_id or repoint a live
# workspace at a different runtime; the update path below repairs the fields it owns.
if run aws_ dynamodb put-item --table-name "$TABLE" --item "file://$STAGING/item.json" \
  --condition-expression 'attribute_not_exists(user_id)' >/dev/null 2>&1; then
  say "Registered $USER_ID / $WORKSPACE_ID"
else
  run aws_ dynamodb update-item --table-name "$TABLE" \
    --key "{\"user_id\":{\"S\":\"$USER_ID\"},\"workspace_id\":{\"S\":\"$WORKSPACE_ID\"}}" \
    --update-expression 'SET runtime_arn = :r, access_point_arn = :a, role_arn = :o, #s = :st' \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":r\":{\"S\":\"$RUNTIME_ARN\"},\":a\":{\"S\":\"$AP_ARN\"},\":o\":{\"S\":\"$ROLE_ARN\"},\":st\":{\"S\":\"ready\"}}" >/dev/null
  say "Updated existing registration for $USER_ID / $WORKSPACE_ID"
fi

cat <<DONE

> Ready. $USER_ID can sign in and get a cube.

  runtime       $RUNTIME_ARN
  access point  $AP_ARN  ($AP_ROOT)
  role          $ROLE_ARN

  Nothing changes in the browser for this user: they authenticate to the mint API, which
  reads this row and signs face-1 .. face-6 against the runtime above.

  Verify the isolation actually holds before trusting it - this is the T-13 test rescoped
  from sessions to access points:

    1. write a file from this user's cube
    2. read it from another user's cube; it must not be there
    3. confirm the runtimes differ:
       aws bedrock-agentcore-control list-agent-runtimes --region $REGION \\
         --query "agentRuntimes[?starts_with(agentRuntimeName, 'cube_u_')].agentRuntimeName"

Teardown for this user only - DESTRUCTIVE, deletes their workspace:

  aws dynamodb delete-item --region $REGION --table-name $TABLE \\
    --key '{"user_id":{"S":"$USER_ID"},"workspace_id":{"S":"$WORKSPACE_ID"}}'
  aws bedrock-agentcore-control delete-agent-runtime --region $REGION --agent-runtime-id $RUNTIME_ID
  aws iam delete-role-policy --role-name $ROLE_NAME --policy-name inline
  aws iam delete-role --role-name $ROLE_NAME
  # this is the line that destroys their files:
  aws efs delete-access-point --region $REGION --access-point-id $AP
  # $AP_ROOT is left on the filesystem; remove it from a mounted host if you mean it

DONE
