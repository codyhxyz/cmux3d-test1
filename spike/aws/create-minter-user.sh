#!/bin/sh
# Creates the IAM user the minter runs as, and stores its key in a named AWS profile.
# EVERY STEP MUTATES AWS. Re-running is safe.
#
# Why this exists: `aws login` issues temporary credentials, so the minter dies with
# AWS_LOGIN_REQUIRED once a day and every face stops reconnecting until a human runs
# `aws login` again. A long-lived key belonging to a user that can do exactly two
# things — invoke this one runtime and open shells on it — removes the human from the
# daily loop without widening the blast radius beyond what the minter already has.
#
# What this user deliberately CANNOT do: create, update or delete anything; read or
# write EFS; touch IAM, ECR, logs, or any other runtime. The key lives in plaintext in
# ~/.aws/credentials on a laptop, so its permissions are the whole of its containment.
set -eu

RUNTIME_ARN="${CUBE_RUNTIME_ARN:-arn:aws:bedrock-agentcore:us-east-1:808175385344:runtime/coding_cube_nat-3RJI162JL3}"
USER_NAME="${CUBE_MINTER_USER:-CodingCubeMinter}"
PROFILE="${CUBE_AWS_PROFILE:-coding-cube}"
POLICY_NAME=inline

DRY_RUN=0
NEW_KEY=0
PRINT_KEY=0
for ARG in "$@"; do
  case "$ARG" in
    --dry-run|--plan) DRY_RUN=1 ;;
    # IAM allows two access keys per user; the secret of an existing one can never be
    # read back, so a lost key is replaced rather than recovered.
    --new-key) NEW_KEY=1 ;;
    # Off by default: the script writes the secret straight into the profile so it
    # never reaches a terminal, a scrollback buffer, or a screen share.
    --print-key) PRINT_KEY=1 ;;
    *) printf 'usage: %s [--dry-run] [--new-key] [--print-key]\n' "$0" >&2; exit 2 ;;
  esac
done

MUTATING=0
CREATED_USER=0
CREATED_KEY=''

say() { printf '\033[36m›\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31m✗\033[0m %s\n' "$1" >&2; teardown >&2; exit 1; }
run() { printf '\033[35m$\033[0m %s\n' "$*" >&2; "$@"; }

teardown() {
  [ "$MUTATING" = 1 ] || return 0
  printf '\nTeardown — the minter stops working the moment the key is deleted.\n\n'
  if [ -n "$CREATED_KEY" ]; then
    printf '  aws iam delete-access-key --user-name %s --access-key-id %s\n' "$USER_NAME" "$CREATED_KEY"
  fi
  printf '  aws iam delete-user-policy --user-name %s --policy-name %s\n' "$USER_NAME" "$POLICY_NAME"
  if [ "$CREATED_USER" = 1 ]; then
    printf '  aws iam delete-user --user-name %s\n' "$USER_NAME"
  fi
  printf '  aws configure set aws_access_key_id "" --profile %s   # and the secret\n' "$PROFILE"
  printf '\n'
}

# ---------------------------------------------------------------- preflight --

command -v aws >/dev/null 2>&1 || die 'The AWS CLI is required.'

case "$RUNTIME_ARN" in
  arn:aws:bedrock-agentcore:*:*:runtime/*) ;;
  *) die "CUBE_RUNTIME_ARN '$RUNTIME_ARN' is not an AgentCore runtime ARN." ;;
esac
REGION=$(printf '%s' "$RUNTIME_ARN" | cut -d: -f4)
ACCOUNT=$(printf '%s' "$RUNTIME_ARN" | cut -d: -f5)
RUNTIME_ID=$(printf '%s' "$RUNTIME_ARN" | sed 's|.*:runtime/||')
# The qualifier lands in the endpoint ARN, not the runtime ARN, and InvokeAgentRuntime
# is authorized against whichever one the call names. Both, or DEFAULT breaks.
ENDPOINT_ARN="$RUNTIME_ARN/runtime-endpoint/*"

printf '%s' "$USER_NAME" | grep -Eq '^[a-zA-Z0-9+=,.@_-]{1,64}$' \
  || die "IAM user name '$USER_NAME' is outside [a-zA-Z0-9+=,.@_-]{1,64}."

CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'No usable AWS credentials. Run `aws login` — this script needs IAM rights the minter never gets.'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "Credentials are for account $CALLER but the runtime lives in $ACCOUNT."

# Read-only, and the one check worth making: a policy scoped to a runtime that does not
# exist grants nothing and fails later as an opaque AccessDeniedException.
aws bedrock-agentcore-control get-agent-runtime --region "$REGION" --agent-runtime-id "$RUNTIME_ID" \
  --query agentRuntimeArn --output text >/dev/null 2>&1 \
  || die "Runtime $RUNTIME_ID does not exist in $REGION. Check CUBE_RUNTIME_ARN."

# Generated rather than kept as a file beside runtime-policy.json: this document is
# nothing but the runtime ARN, so a static copy could only ever go stale against
# CUBE_RUNTIME_ARN — silently, since a mismatched ARN denies rather than errors.
POLICY_FILE=$(mktemp)
trap 'rm -f "$POLICY_FILE"' EXIT INT TERM
cat > "$POLICY_FILE" <<POLICY
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "InvokeAndOpenShellsOnExactlyOneRuntime",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:InvokeAgentRuntime",
        "bedrock-agentcore:InvokeAgentRuntimeCommandShell"
      ],
      "Resource": [
        "$RUNTIME_ARN",
        "$ENDPOINT_ARN"
      ]
    }
  ]
}
POLICY

# ------------------------------------------------------------------- survey --

USER_EXISTS=0
if aws iam get-user --user-name "$USER_NAME" >/dev/null 2>&1; then USER_EXISTS=1; fi

KEY_COUNT=0
if [ "$USER_EXISTS" = 1 ]; then
  KEY_COUNT=$(aws iam list-access-keys --user-name "$USER_NAME" \
    --query 'length(AccessKeyMetadata)' --output text 2>/dev/null || echo 0)
  case "$KEY_COUNT" in ''|*[!0-9]*) KEY_COUNT=0 ;; esac
fi

MAKE_KEY=1
if [ "$KEY_COUNT" -ge 1 ] && [ "$NEW_KEY" = 0 ]; then MAKE_KEY=0; fi

PROFILE_IN_USE=0
if aws configure get aws_access_key_id --profile "$PROFILE" >/dev/null 2>&1; then PROFILE_IN_USE=1; fi

# --------------------------------------------------------------------- plan --

printf '\n'
say "Plan — account $ACCOUNT, region $REGION"
printf '\n'
printf '  IAM user        %-28s %s\n' "$USER_NAME" "$([ "$USER_EXISTS" = 1 ] && echo 'exists, skip' || echo 'CREATE')"
printf '  Inline policy   %-28s %s\n' "$USER_NAME/$POLICY_NAME" 'PUT (overwrites)'
printf '  Access key      %-28s %s\n' "$USER_NAME" "$([ "$MAKE_KEY" = 1 ] && echo 'CREATE' || echo "$KEY_COUNT already exist, skip (--new-key to add one)")"
printf '  Local profile   %-28s %s\n' "$PROFILE" "$([ "$MAKE_KEY" = 0 ] && echo 'untouched' || ([ "$PRINT_KEY" = 1 ] && echo 'printed, not written' || echo 'WRITE ~/.aws/credentials'))"
printf '\n'
printf '  The whole of what this user may do:\n\n'
sed 's/^/    /' "$POLICY_FILE"
printf '\n'

if [ "$PROFILE_IN_USE" = 1 ] && [ "$MAKE_KEY" = 1 ] && [ "$PRINT_KEY" = 0 ]; then
  warn "Profile [$PROFILE] already has a key; it will be overwritten."
fi
if [ "$MAKE_KEY" = 0 ]; then
  warn "The secret of an existing access key cannot be read back. If you no longer have it, re-run with --new-key (IAM allows 2 per user)."
fi
warn 'This key is long-lived and lives in plaintext on this machine. Deleting it (teardown below) is the only revocation.'

if [ "$DRY_RUN" = 1 ]; then
  say 'Dry run — nothing was changed.'
  exit 0
fi

[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run to see the plan.'
CONFIRM="create minter user $USER_NAME"
printf 'This mutates AWS. Type exactly: %s\n> ' "$CONFIRM"
read -r ANSWER
[ "$ANSWER" = "$CONFIRM" ] || die 'Not confirmed. Nothing was changed.'
printf '\n'

# ------------------------------------------------------------------ mutate --

MUTATING=1

if [ "$USER_EXISTS" = 0 ]; then
  run aws iam create-user --user-name "$USER_NAME" \
    --tags Key=Project,Value=coding-cube "Key=Runtime,Value=$RUNTIME_ID" >/dev/null
  CREATED_USER=1
  say "Created user $USER_NAME"
fi

run aws iam put-user-policy --user-name "$USER_NAME" --policy-name "$POLICY_NAME" \
  --policy-document "file://$POLICY_FILE"
say "Scoped $USER_NAME to $RUNTIME_ID and nothing else"

if [ "$MAKE_KEY" = 1 ]; then
  KEY_PAIR=$(aws iam create-access-key --user-name "$USER_NAME" \
    --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text) \
    || die 'create-access-key failed.'
  CREATED_KEY=$(printf '%s' "$KEY_PAIR" | cut -f1)
  KEY_SECRET=$(printf '%s' "$KEY_PAIR" | cut -f2)
  [ -n "$KEY_SECRET" ] || die 'create-access-key returned no secret.'
  say "Created access key $CREATED_KEY"

  if [ "$PRINT_KEY" = 1 ]; then
    printf '\n  aws configure set aws_access_key_id %s --profile %s\n' "$CREATED_KEY" "$PROFILE"
    printf '  aws configure set aws_secret_access_key %s --profile %s\n' "$KEY_SECRET" "$PROFILE"
    printf '  aws configure set region %s --profile %s\n\n' "$REGION" "$PROFILE"
    warn 'The secret above is shown once and cannot be retrieved again.'
  else
    aws configure set aws_access_key_id "$CREATED_KEY" --profile "$PROFILE"
    aws configure set aws_secret_access_key "$KEY_SECRET" --profile "$PROFILE"
    aws configure set region "$REGION" --profile "$PROFILE"
    say "Wrote profile [$PROFILE] (the secret was never printed)"
  fi
  KEY_SECRET=
fi

# ------------------------------------------------------------------ verify --

if [ "$MAKE_KEY" = 1 ] && [ "$PRINT_KEY" = 0 ]; then
  # A new access key takes a few seconds to become usable; until then every call is
  # InvalidClientTokenId, which reads exactly like a typo.
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 12 ]; do
    IDENTITY=$(aws sts get-caller-identity --profile "$PROFILE" --query Arn --output text 2>/dev/null || true)
    case "$IDENTITY" in
      *":user/$USER_NAME") break ;;
    esac
    IDENTITY=''
    ATTEMPT=$((ATTEMPT + 1))
    sleep 5
  done
  [ -n "$IDENTITY" ] || die "Profile [$PROFILE] never authenticated as $USER_NAME. The key may still be propagating; retry aws sts get-caller-identity --profile $PROFILE in a minute."
  say "Profile [$PROFILE] authenticates as $IDENTITY"
fi

# Best effort: the admin running this may not hold iam:SimulatePrincipalPolicy, and a
# missing simulation is not a reason to fail a create that otherwise succeeded.
DECISION=$(aws iam simulate-principal-policy \
  --policy-source-arn "arn:aws:iam::$ACCOUNT:user/$USER_NAME" \
  --action-names bedrock-agentcore:InvokeAgentRuntimeCommandShell \
  --resource-arns "$RUNTIME_ARN" \
  --query 'EvaluationResults[0].EvalDecision' --output text 2>/dev/null || true)
case "$DECISION" in
  allowed) say 'Simulated: InvokeAgentRuntimeCommandShell on the runtime is allowed' ;;
  '') warn 'Could not simulate the policy (needs iam:SimulatePrincipalPolicy); skipped.' ;;
  *) warn "Policy simulation says '$DECISION' for InvokeAgentRuntimeCommandShell. Shells will be refused." ;;
esac

# -------------------------------------------------------------------- done --

printf '\n'
say 'Ready. The minter no longer depends on a human session.'
printf '\n'
printf '  export CUBE_AWS_PROFILE=%s\n' "$PROFILE"
printf '  export CUBE_RUNTIME_ARN=%s\n' "$RUNTIME_ARN"
printf '  npm start\n'
printf '\n'
printf 'Put those two exports in your shell profile and `npm start` is the whole cloud path.\n'
printf 'Without CUBE_AWS_PROFILE the minter falls back to the default chain and keeps\n'
printf 'answering AWS_LOGIN_REQUIRED once a day, which is the old behaviour, not a bug.\n'
teardown
