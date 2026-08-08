#!/bin/sh
# The workspace registry: user_id -> workspace_id -> runtime, access point, session.
# EVERY STEP MUTATES AWS. Re-running is safe.
#
# The key shape is the security design, not a storage convenience. user_id is the PARTITION
# key and is always the Cognito `sub` the mint Lambda verified; workspace_id is the sort key
# and is the only part a request can influence. GetItem on that pair is the only read the
# Lambda performs, so "somebody else's workspace" is not expressible in its API surface.
#
# The by_runtime index exists for incident response ("who owns cube_u_xxx?") and is
# deliberately NOT readable by the mint Lambda: infra/policies/mint-policy.json grants
# table/coding-cube-workspaces and not table/coding-cube-workspaces/index/*, so a Query
# against it is denied by IAM even if someone adds the code.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
TABLE="${CUBE_TABLE:-coding-cube-workspaces}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/aws-common.sh"
aws_common_parse_dry_run "$@"
aws_verify_account

EXISTS=0
aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1 && EXISTS=1

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    Table            $TABLE   $([ "$EXISTS" = 1 ] && echo 'exists, skip' || echo CREATE)
    Keys             user_id (HASH, Cognito sub) + workspace_id (RANGE)
    Index            by_runtime (runtime_arn, KEYS_ONLY) - operations only
    Billing          PAY_PER_REQUEST
    Backup           point-in-time recovery ON
    Protection       deletion protection ON

  Item shape written by spike/aws/create-user-workspace.sh:

    user_id             S  Cognito sub
    workspace_id        S  "default"
    runtime_arn         S  arn:aws:bedrock-agentcore:...:runtime/cube_u_<sub>-<id>
    access_point_arn    S  arn:aws:elasticfilesystem:...:access-point/fsap-...
    role_arn            S  the per-user execution role
    status              S  ready | provisioning | suspended
    runtime_session_id  S  written by the Lambda on first use
    session_seen_at     N  epoch ms
    created_at          N  epoch ms

  Cost: on-demand DynamoDB at this volume rounds to zero. One face reconnecting every 270
  seconds is roughly 8,000 reads per user-month, or about \$0.001.

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS. Type exactly: create table %s\n> ' "$TABLE"
read -r ANSWER
[ "$ANSWER" = "create table $TABLE" ] || die 'aborted'

if [ "$EXISTS" = 0 ]; then
  run aws_ dynamodb create-table \
    --table-name "$TABLE" \
    --billing-mode PAY_PER_REQUEST \
    --deletion-protection-enabled \
    --attribute-definitions \
      AttributeName=user_id,AttributeType=S \
      AttributeName=workspace_id,AttributeType=S \
      AttributeName=runtime_arn,AttributeType=S \
    --key-schema \
      AttributeName=user_id,KeyType=HASH \
      AttributeName=workspace_id,KeyType=RANGE \
    --global-secondary-indexes \
      'IndexName=by_runtime,KeySchema=[{AttributeName=runtime_arn,KeyType=HASH}],Projection={ProjectionType=KEYS_ONLY}' \
    --tags Key=Name,Value=coding-cube >/dev/null
  say "Created table $TABLE"
  printf 'waiting for %s to become ACTIVE' "$TABLE"
  while [ "$(aws_ dynamodb describe-table --table-name "$TABLE" --query 'Table.TableStatus' --output text)" != 'ACTIVE' ]; do
    printf '.'; sleep 3
  done
  printf '\n'
else
  say "Table $TABLE already exists"
fi

PITR=$(aws_ dynamodb describe-continuous-backups --table-name "$TABLE" \
  --query 'ContinuousBackupsDescription.PointInTimeRecoveryDescription.PointInTimeRecoveryStatus' --output text 2>/dev/null || echo DISABLED)
if [ "$PITR" != 'ENABLED' ]; then
  run aws_ dynamodb update-continuous-backups --table-name "$TABLE" \
    --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true >/dev/null
  say 'Enabled point-in-time recovery'
else
  say 'Point-in-time recovery already enabled'
fi

cat <<DONE

> Ready.

  export CUBE_TABLE=$TABLE

  Losing this table does not lose any user's files - those are on EFS, addressed by the
  access point. It loses the mapping, which spike/aws/create-user-workspace.sh can rebuild
  from the access point tags. Point-in-time recovery is on anyway.

Teardown - DESTRUCTIVE, orphans every workspace mapping:

  aws dynamodb update-table --region $REGION --table-name $TABLE --no-deletion-protection-enabled
  aws dynamodb delete-table --region $REGION --table-name $TABLE

DONE
