#!/bin/sh
# Creates the AgentCore spike runtime: ECR repository, execution role, agent runtime.
# EVERY STEP MUTATES AWS. Re-running is safe; the teardown it prints is not.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
ECR_REPO="${CUBE_ECR_REPO:-coding-cube-spike}"
IMAGE_TAG="${CUBE_IMAGE_TAG:-v1}"
ROLE_NAME="${CUBE_ROLE:-CodingCubeSpikeRuntime}"
# agentRuntimeName is [a-zA-Z][a-zA-Z0-9_]{0,47}. A hyphen is rejected outright.
RUNTIME_NAME="${CUBE_RUNTIME_NAME:-coding_cube_spike}"
# MountPath is /mnt/<one level>, 6-200 chars, pattern /mnt/[a-zA-Z0-9._-]+/?
MOUNT_PATH="${CUBE_MOUNT_PATH:-/mnt/workspace}"
# Both lifecycle values are integers bounded 60..28800. 60 is the API minimum and turns
# the sleep/wake test from a 15-minute wait into about 90 seconds. It is a spike
# accelerator, not a shippable value.
IDLE_TIMEOUT="${CUBE_IDLE_TIMEOUT:-60}"
MAX_LIFETIME="${CUBE_MAX_LIFETIME:-3600}"
# 2.33.15 has no filesystemConfigurations in its bundled model at all — the flag
# is rejected at argument parse, so session storage cannot be expressed.
MIN_CLI="2.34.16"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
IMAGE_URI="$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$ECR_REPO:$IMAGE_TAG"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE_NAME"
CONFIRM="create $RUNTIME_NAME in $REGION"

ARTIFACT="{\"containerConfiguration\":{\"containerUri\":\"$IMAGE_URI\"}}"
NETWORK='{"networkMode":"PUBLIC"}'
PROTOCOL='{"serverProtocol":"HTTP"}'
LIFECYCLE="{\"idleRuntimeSessionTimeout\":$IDLE_TIMEOUT,\"maxLifetime\":$MAX_LIFETIME}"
FILESYSTEM="[{\"sessionStorage\":{\"mountPath\":\"$MOUNT_PATH\"}}]"
METADATA='{"requireMMDSV2":true}'
# HOME is load-bearing, not cosmetic: herdr silently ignores HERDR_SOCKET_PATH whenever
# --session is passed (which every call in this repo does), so the live socket is always
# $HOME/.config/herdr/herdr.sock. The gateway and any platform-spawned shell only find
# the same socket if they agree on HOME. HERDR_SOCKET_PATH is kept pointing at that same
# path so a hypothetical no---session call cannot be sent somewhere else.
ENVIRONMENT="{\"CODING_CUBE_SPIKE\":\"1\",\"CODING_CUBE_GATEWAY_ONLY\":\"1\",\"CODING_CUBE_MOUNT\":\"$MOUNT_PATH\",\"CODING_CUBE_WORKDIR\":\"$MOUNT_PATH/work\",\"HOME\":\"/home/cube\",\"HERDR_SOCKET_PATH\":\"/home/cube/.config/herdr/herdr.sock\"}"

DRY_RUN=0
case "${1:-}" in
  --dry-run|--plan) DRY_RUN=1 ;;
  '') ;;
  *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
esac

# Flipped to 1 the moment the first mutation is authorised, so every `die` after that
# point prints the teardown for whatever this run has actually built.
MUTATING=0
CREATED_REPO=0
CREATED_ROLE=0
RUNTIME_ID=''

say() { printf '\033[36m›\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; teardown >&2; exit 1; }
# The trace goes to stderr so `run` stays usable inside a command substitution.
run() { printf '\033[35m$\033[0m %s\n' "$*" >&2; "$@"; }
aws_() { aws --region "$REGION" "$@"; }
. "$HERE/runtime-lib.sh"

teardown() {
  [ "$MUTATING" = 1 ] || return 0
  printf '\nTeardown — DESTRUCTIVE. Deleting the runtime deletes all session storage with it.\n\n'
  if [ -n "$RUNTIME_ID" ]; then
    printf '  aws bedrock-agentcore-control delete-agent-runtime --region %s --agent-runtime-id %s\n' "$REGION" "$RUNTIME_ID"
  fi
  printf '  aws iam delete-role-policy --role-name %s --policy-name inline\n' "$ROLE_NAME"
  # Only offered for resources this run created; a pre-existing repo may hold images
  # that have nothing to do with the spike, and --force would take them with it.
  if [ "$CREATED_ROLE" = 1 ]; then
    printf '  aws iam delete-role --role-name %s\n' "$ROLE_NAME"
  fi
  if [ "$CREATED_REPO" = 1 ]; then
    printf '  aws ecr delete-repository --region %s --repository-name %s --force\n' "$REGION" "$ECR_REPO"
  fi
  printf '\n'
}

in_range() {
  case "$1" in ''|*[!0-9]*) return 1 ;; esac
  [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

# ---------------------------------------------------------------- preflight --

command -v aws >/dev/null 2>&1 || die "The AWS CLI is required."
CLI_VERSION=$(aws --version 2>&1 | sed -n 's|^aws-cli/\([0-9][0-9.]*\).*|\1|p')
[ -n "$CLI_VERSION" ] || die "Could not read a version out of \`aws --version\`."
runtime_version_ge "$CLI_VERSION" "$MIN_CLI" \
  || die "AWS CLI $CLI_VERSION cannot express --filesystem-configurations; $MIN_CLI or newer is required. Run \`brew upgrade awscli\`."

# Shapes verified against the bundled botocore model rather than trusted from the docs.
printf '%s' "$RUNTIME_NAME" | grep -Eq '^[a-zA-Z][a-zA-Z0-9_]{0,47}$' \
  || die "agentRuntimeName '$RUNTIME_NAME' does not match [a-zA-Z][a-zA-Z0-9_]{0,47} — hyphens are rejected."
printf '%s' "$MOUNT_PATH" | grep -Eq '^/mnt/[a-zA-Z0-9._-]+/?$' \
  || die "mountPath '$MOUNT_PATH' does not match /mnt/[a-zA-Z0-9._-]+/? — it must be /mnt plus exactly one level."
in_range "$IDLE_TIMEOUT" 60 28800 || die "idleRuntimeSessionTimeout $IDLE_TIMEOUT is outside 60..28800."
in_range "$MAX_LIFETIME" 60 28800 || die "maxLifetime $MAX_LIFETIME is outside 60..28800."

# The version check is the documented gate; the skeletons are what actually prove this
# CLI's bundled model carries the fields we send.
printf '%s' "$(aws bedrock-agentcore-control create-agent-runtime --generate-cli-skeleton 2>/dev/null || true)" \
  | grep -q filesystemConfigurations \
  || die "This CLI ($CLI_VERSION) reports no filesystemConfigurations on create-agent-runtime. Upgrade it, or fall back to CloudFormation's AWS::BedrockAgentCore::Runtime."
# metadataConfiguration is a member of UpdateAgentRuntimeRequest ONLY — it is absent from
# CreateAgentRuntimeRequest in the service model, so MMDSv2 cannot be set at create time
# and provisioning is unavoidably two calls.
printf '%s' "$(aws bedrock-agentcore-control update-agent-runtime --generate-cli-skeleton 2>/dev/null || true)" \
  | grep -q metadataConfiguration \
  || die "This CLI ($CLI_VERSION) reports no metadataConfiguration on update-agent-runtime, which is the only place requireMMDSV2 exists. Interactive shells cannot be enabled with it."

CALLER=$(aws sts get-caller-identity --query Account --output text) \
  || die "No usable AWS credentials."
[ "$CALLER" = "$ACCOUNT" ] \
  || die "Credentials are for account $CALLER but the policy files in $HERE are written for $ACCOUNT. Edit them, or set CUBE_ACCOUNT."

[ -f "$HERE/runtime-trust.json" ] || die "Missing $HERE/runtime-trust.json"
[ -f "$HERE/runtime-policy.json" ] || die "Missing $HERE/runtime-policy.json"

# The two policy documents are static ARNs, so a CUBE_REGION / CUBE_ECR_REPO /
# CUBE_RUNTIME_NAME override silently desynchronises them from what is being created —
# and the symptom is a create-agent-runtime failure that reads as IAM propagation.
grep -qF "arn:aws:bedrock-agentcore:$REGION:$ACCOUNT:runtime/" "$HERE/runtime-trust.json" \
  || die "runtime-trust.json does not trust arn:aws:bedrock-agentcore:$REGION:$ACCOUNT:runtime/* — AgentCore in $REGION cannot assume this role. Edit it, or unset CUBE_REGION."
grep -qF "arn:aws:ecr:$REGION:$ACCOUNT:repository/$ECR_REPO" "$HERE/runtime-policy.json" \
  || die "runtime-policy.json does not grant pull on arn:aws:ecr:$REGION:$ACCOUNT:repository/$ECR_REPO. Edit it, or unset CUBE_REGION/CUBE_ECR_REPO."
grep -qF "arn:aws:logs:$REGION:$ACCOUNT:log-group:/aws/bedrock-agentcore/runtimes/$RUNTIME_NAME-" "$HERE/runtime-policy.json" \
  || die "runtime-policy.json does not grant logs for runtime $RUNTIME_NAME in $REGION. Edit it, or unset CUBE_REGION/CUBE_RUNTIME_NAME."

# ------------------------------------------------------------------- survey --

REPO_EXISTS=0
if aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1; then REPO_EXISTS=1; fi

IMAGE_EXISTS=0
if [ "$REPO_EXISTS" = 1 ] && aws ecr describe-images --region "$REGION" --repository-name "$ECR_REPO" --image-ids "imageTag=$IMAGE_TAG" >/dev/null 2>&1; then IMAGE_EXISTS=1; fi

ROLE_EXISTS=0
if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then ROLE_EXISTS=1; fi

RUNTIME_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
  --query "agentRuntimes[?agentRuntimeName=='$RUNTIME_NAME'].agentRuntimeId | [0]" --output text 2>/dev/null || true)
if [ "$RUNTIME_ID" = "None" ]; then RUNTIME_ID=''; fi

MMDS_OK=0
if [ -n "$RUNTIME_ID" ]; then
  MMDS=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RUNTIME_ID" \
    --query 'metadataConfiguration.requireMMDSV2' --output text 2>/dev/null || true)
  if [ "$MMDS" = "True" ]; then MMDS_OK=1; fi
fi

# --------------------------------------------------------------------- plan --

printf '\n'
say "Plan — account $ACCOUNT, region $REGION"
printf '\n'
printf '  ECR repository  %-28s %s\n' "$ECR_REPO" "$([ "$REPO_EXISTS" = 1 ] && echo 'exists, skip' || echo 'CREATE')"
printf '  IAM role        %-28s %s\n' "$ROLE_NAME" "$([ "$ROLE_EXISTS" = 1 ] && echo 'exists, skip' || echo 'CREATE')"
printf '  Inline policy   %-28s %s\n' "$ROLE_NAME/inline" 'PUT (overwrites)'
printf '  Agent runtime   %-28s %s\n' "$RUNTIME_NAME" "$([ -n "$RUNTIME_ID" ] && echo "exists ($RUNTIME_ID), skip" || echo 'CREATE')"
printf '  MMDSv2          %-28s %s\n' 'requireMMDSV2=true' "$([ "$MMDS_OK" = 1 ] && echo 'already set, skip' || echo 'UPDATE (bumps the runtime version)')"
printf '\n'
printf '  container       %s\n' "$IMAGE_URI"
printf '  role            %s\n' "$ROLE_ARN"
printf '  network         %s\n' "$NETWORK"
printf '  protocol        %s\n' "$PROTOCOL"
printf '  lifecycle       %s\n' "$LIFECYCLE"
printf '  filesystem      %s\n' "$FILESYSTEM"
printf '  environment     %s\n' "$ENVIRONMENT"
printf '\n'

if [ "$IMAGE_EXISTS" = 0 ]; then
  warn "$IMAGE_URI is not in ECR yet. Push it first (spike/finch.sh push) or the runtime will fail to start."
fi
if [ "$MMDS_OK" = 0 ] && [ -n "$RUNTIME_ID" ]; then
  warn 'Enabling MMDSv2 creates a new runtime version, and a version update WIPES managed session storage for every session.'
fi
warn "idleRuntimeSessionTimeout=$IDLE_TIMEOUT is the API minimum, chosen to make sleep/wake testable. Do not ship it."

if [ "$DRY_RUN" = 1 ]; then
  say 'Dry run — nothing was changed.'
  exit 0
fi

[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run to see the plan.'
printf 'This mutates AWS. Type exactly: %s\n> ' "$CONFIRM"
read -r ANSWER
[ "$ANSWER" = "$CONFIRM" ] || die 'Not confirmed. Nothing was changed.'
printf '\n'

# ------------------------------------------------------------------ mutate --

MUTATING=1

if [ "$REPO_EXISTS" = 0 ]; then
  run aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPO" >/dev/null
  CREATED_REPO=1
  say "Created ECR repository $ECR_REPO"
fi

if [ "$ROLE_EXISTS" = 0 ]; then
  run aws iam create-role --role-name "$ROLE_NAME" \
    --description 'Coding Cube AgentCore spike. Readable from inside the microVM via MMDS, so keep it near-empty.' \
    --assume-role-policy-document "file://$HERE/runtime-trust.json" >/dev/null
  CREATED_ROLE=1
  say "Created role $ROLE_NAME"
fi
run aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name inline \
  --policy-document "file://$HERE/runtime-policy.json"

RUNTIME_FAILURE_HINT="Check the image (linux/arm64, under 53 layers, numeric USER) and that $ROLE_NAME is assumable — a too-narrow aws:SourceArn in runtime-trust.json fails exactly here."
RUNTIME_CREATE_FAILURE='create-agent-runtime kept failing.'

if [ -z "$RUNTIME_ID" ]; then
  # IAM is eventually consistent, so a role created seconds ago may not be
  # assumable yet — and that shows up as a create-agent-runtime failure, not an IAM one.
  runtime_create_with_retry "$RUNTIME_NAME" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration "$NETWORK" \
    --protocol-configuration "$PROTOCOL" \
    --lifecycle-configuration "$LIFECYCLE" \
    --filesystem-configurations "$FILESYSTEM" \
    --environment-variables "$ENVIRONMENT"
fi

# requireMMDSV2 is not a member of CreateAgentRuntime — it exists only on
# UpdateAgentRuntime, which is a full replace, hence every field goes back in.
# Interactive shells are rejected with "This runtime is not MMDSv2-enabled" without it.
# This runs immediately after create because an update bumps the runtime version and a
# version bump WIPES managed session storage: do it now, while there is none to lose.
if [ "$MMDS_OK" = 0 ]; then
  runtime_enable_mmdsv2 "$RUNTIME_ID" \
    --agent-runtime-artifact "$ARTIFACT" \
    --role-arn "$ROLE_ARN" \
    --network-configuration "$NETWORK" \
    --protocol-configuration "$PROTOCOL" \
    --lifecycle-configuration "$LIFECYCLE" \
    --filesystem-configurations "$FILESYSTEM" \
    --environment-variables "$ENVIRONMENT"
fi

# ------------------------------------------------------------------ verify --

RUNTIME_ARN=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
  --agent-runtime-id "$RUNTIME_ID" --query agentRuntimeArn --output text)
MMDS=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
  --agent-runtime-id "$RUNTIME_ID" --query 'metadataConfiguration.requireMMDSV2' --output text)
MOUNTED=$(aws bedrock-agentcore-control get-agent-runtime --region "$REGION" \
  --agent-runtime-id "$RUNTIME_ID" --query 'filesystemConfigurations[0].sessionStorage.mountPath' --output text)

[ "$MMDS" = "True" ] || die "requireMMDSV2 reads back as '$MMDS'. Interactive shells will be rejected."
[ "$MOUNTED" = "$MOUNT_PATH" ] || die "Session storage reads back as '$MOUNTED', expected $MOUNT_PATH."

printf '\n'
say 'Ready.'
printf '\n'
printf '  export CUBE_RUNTIME_ARN=%s\n' "$RUNTIME_ARN"
printf '  export CUBE_REGION=%s\n' "$REGION"
printf '\n'
printf 'Session IDs have a 33-character minimum: cube-spike-$(uuidgen) is 47.\n'
teardown
