#!/bin/sh
# The authorize-then-mint endpoint: IAM role, Lambda, HTTP API with a Cognito JWT authorizer.
# EVERY STEP MUTATES AWS. Re-running is safe and is also how you redeploy the function.
#
# This replaces spike/mint-server.mjs for multi-user. It is the same job — sign one 300-second
# shell URL per face per reconnect — with the one part the loopback minter does not have:
# it decides *whose* runtime to sign for, from a verified token rather than from "you can
# reach 127.0.0.1".
#
# There is no loopback anywhere in this path. Chrome 151 blocks https -> loopback outright
# ("Permission was denied for this request to access the `loopback` address space", and
# Access-Control-Allow-Private-Network no longer helps), which is why the single-operator
# minter serves the Cube itself. Here both the app and the API are ordinary https origins,
# so the problem does not arise.
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
FUNCTION="${CUBE_MINT_FUNCTION:-coding-cube-mint}"
API_NAME="${CUBE_MINT_API_NAME:-coding-cube-mint}"
ROLE_NAME="${CUBE_MINT_ROLE:-CodingCubeMint}"
TABLE="${CUBE_TABLE:-coding-cube-workspaces}"
APP_ORIGIN="${CUBE_APP_ORIGIN:-https://codingcube.codyh.xyz}"
QUALIFIER="${CUBE_QUALIFIER:-DEFAULT}"
# 300 is the AgentCore maximum for a presigned URL. The client re-mints at 270.
EXPIRES_IN="${CUBE_EXPIRES_IN:-300}"
# free | pinned. See infra/lambda/mint.mjs. `free` keeps the browser's existing session model
# and therefore requires no client change at all beyond the origin.
SESSION_POLICY="${CUBE_SESSION_POLICY:-free}"
RUNTIME="${CUBE_LAMBDA_RUNTIME:-nodejs22.x}"
LOG_RETENTION_DAYS="${CUBE_LOG_RETENTION_DAYS:-30}"
# /prepare invokes the user's runtime, which can be a cold start. Everything else is local
# crypto and one DynamoDB read.
TIMEOUT="${CUBE_LAMBDA_TIMEOUT:-60}"
MEMORY="${CUBE_LAMBDA_MEMORY:-512}"
# Per-route throttling. A mint is free to serve but a /prepare is a real invocation of a real
# microVM, so this is a cost control as much as an abuse control.
RATE="${CUBE_API_RATE:-10}"
BURST="${CUBE_API_BURST:-20}"

USER_POOL_ID="${CUBE_USER_POOL_ID:-}"
APP_CLIENT_ID="${CUBE_APP_CLIENT_ID:-}"

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INFRA=$(CDPATH= cd -- "$HERE/.." && pwd)
LAMBDA_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FUNCTION"
ROLE_ARN="arn:aws:iam::$ACCOUNT:role/$ROLE_NAME"
LOG_GROUP="/aws/lambda/$FUNCTION"
API_LOG_GROUP="/aws/apigateway/$API_NAME"

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

command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
command -v zip >/dev/null 2>&1 || die 'zip is required to build the deployment package'
CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'no usable AWS credentials'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "credentials are for account $CALLER but this script targets $ACCOUNT"

[ -n "$USER_POOL_ID" ] || die 'CUBE_USER_POOL_ID is required. Run infra/aws/create-identity.sh first.'
[ -n "$APP_CLIENT_ID" ] || die 'CUBE_APP_CLIENT_ID is required. Run infra/aws/create-identity.sh first.'
# A missing prerequisite is fatal to a real run but must not stop --dry-run printing a plan;
# the whole point of the plan is to read it before anything exists.
need() { if [ "$DRY_RUN" = 1 ]; then warn "$1"; else die "$1"; fi; }
aws_ dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1 \
  || need "table $TABLE does not exist. Run infra/aws/create-workspace-table.sh first."

for FILE in mint.mjs jwt.mjs sigv4.mjs workspaces.mjs; do
  [ -f "$INFRA/lambda/$FILE" ] || die "missing $INFRA/lambda/$FILE"
done
[ -f "$INFRA/policies/mint-trust.json" ] || die "missing $INFRA/policies/mint-trust.json"
[ -f "$INFRA/policies/mint-policy.json" ] || die "missing $INFRA/policies/mint-policy.json"

# The policy documents are static ARNs, so an override here silently desynchronises them from
# what is being created - and that surfaces as AccessDenied inside the Lambda at 3am, not as
# a failure of this script.
grep -qF "arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE" "$INFRA/policies/mint-policy.json" \
  || die "mint-policy.json does not grant access to table/$TABLE in $REGION. Edit it, or unset CUBE_TABLE/CUBE_REGION."
grep -qF "arn:aws:logs:$REGION:$ACCOUNT:log-group:$LOG_GROUP" "$INFRA/policies/mint-policy.json" \
  || die "mint-policy.json does not grant logs for $LOG_GROUP in $REGION. Edit it, or unset CUBE_MINT_FUNCTION/CUBE_REGION."
grep -qF "\"aws:SourceAccount\": \"$ACCOUNT\"" "$INFRA/policies/mint-trust.json" \
  || die "mint-trust.json does not name account $ACCOUNT."

ISSUER="https://cognito-idp.$REGION.amazonaws.com/$USER_POOL_ID"
API_ID=$(aws_ apigatewayv2 get-apis --query "Items[?Name=='$API_NAME'].ApiId | [0]" --output text 2>/dev/null || echo None)
[ "$API_ID" = 'None' ] && API_ID=''
FUNCTION_EXISTS=0
aws_ lambda get-function --function-name "$FUNCTION" >/dev/null 2>&1 && FUNCTION_EXISTS=1
ROLE_EXISTS=0
aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1 && ROLE_EXISTS=1

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    IAM role        $ROLE_NAME              $([ "$ROLE_EXISTS" = 1 ] && echo 'exists, policy overwritten' || echo CREATE)
    Lambda          $FUNCTION ($RUNTIME, arm64, ${MEMORY}MB, ${TIMEOUT}s)   $([ "$FUNCTION_EXISTS" = 1 ] && echo 'exists, CODE REPLACED' || echo CREATE)
    HTTP API        $API_NAME              $([ -n "$API_ID" ] && echo "exists as $API_ID" || echo CREATE)
    Authorizer      JWT, issuer $ISSUER
                    audience $APP_CLIENT_ID
    Routes          GET /session   GET /prepare   GET /mint      (all JWT-authorized)
    CORS            $APP_ORIGIN
    Throttle        $RATE/s sustained, $BURST burst
    Session policy  $SESSION_POLICY
    Log retention   ${LOG_RETENTION_DAYS}d on $LOG_GROUP and $API_LOG_GROUP

  Cost: Lambda and HTTP API are per-request and free at this scale for the first million
  calls a month. Nothing here has a standing charge. The money is in the per-user agent
  runtimes and the shared NAT gateway, not in this control plane.

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS. Type exactly: deploy mint %s\n> ' "$API_NAME"
read -r ANSWER
[ "$ANSWER" = "deploy mint $API_NAME" ] || die 'aborted'

# -- deployment package --------------------------------------------------------
STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT INT TERM
cp "$INFRA/lambda/mint.mjs" "$INFRA/lambda/jwt.mjs" "$INFRA/lambda/sigv4.mjs" "$INFRA/lambda/workspaces.mjs" "$STAGING/"
# .mjs everywhere, so no package.json is needed to select ESM - and no package.json means no
# dependency manifest, which is the point: this function has none.
( cd "$STAGING" && zip -q -X mint.zip mint.mjs jwt.mjs sigv4.mjs workspaces.mjs )
say "Built $(wc -c < "$STAGING/mint.zip" | tr -d ' ') byte deployment package (4 files, 0 dependencies)"

# -- log groups ----------------------------------------------------------------
for GROUP in "$LOG_GROUP" "$API_LOG_GROUP"; do
  aws_ logs create-log-group --log-group-name "$GROUP" >/dev/null 2>&1 || true
  run aws_ logs put-retention-policy --log-group-name "$GROUP" --retention-in-days "$LOG_RETENTION_DAYS" >/dev/null
done
say "Log groups ready with ${LOG_RETENTION_DAYS}-day retention"

# -- role ----------------------------------------------------------------------
if [ "$ROLE_EXISTS" = 0 ]; then
  run aws iam create-role --role-name "$ROLE_NAME" \
    --description 'Coding Cube mint endpoint. Holds the only credentials that can presign a shell URL.' \
    --assume-role-policy-document "file://$INFRA/policies/mint-trust.json" >/dev/null
  say "Created role $ROLE_NAME"
fi
run aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name inline \
  --policy-document "file://$INFRA/policies/mint-policy.json"
say 'Inline policy written'
warn 'InvokeAgentRuntimeCommandShell has no SDK operation - the action name comes from the Service Quotas table. If a face gets 403 at the WebSocket handshake while /prepare succeeds, that name is what to check.'

ENVIRONMENT="Variables={CUBE_REGION=$REGION,CUBE_TABLE=$TABLE,CUBE_USER_POOL_ID=$USER_POOL_ID,CUBE_APP_CLIENT_ID=$APP_CLIENT_ID,CUBE_QUALIFIER=$QUALIFIER,CUBE_EXPIRES_IN=$EXPIRES_IN,CUBE_SESSION_POLICY=$SESSION_POLICY,CUBE_ALLOWED_ORIGINS=$APP_ORIGIN}"

if [ "$FUNCTION_EXISTS" = 0 ]; then
  # IAM is eventually consistent and a role created seconds ago is not assumable yet; that
  # arrives as an InvalidParameterValueException naming the role, not as an IAM error.
  ATTEMPT=0
  while :; do
    if run aws_ lambda create-function \
      --function-name "$FUNCTION" \
      --runtime "$RUNTIME" \
      --architectures arm64 \
      --role "$ROLE_ARN" \
      --handler mint.handler \
      --timeout "$TIMEOUT" \
      --memory-size "$MEMORY" \
      --environment "$ENVIRONMENT" \
      --zip-file "fileb://$STAGING/mint.zip" >/dev/null 2>&1; then break; fi
    ATTEMPT=$((ATTEMPT + 1))
    [ "$ATTEMPT" -lt 6 ] || die 'create-function kept failing. Re-run: the role now exists, so this is likely not propagation.'
    warn "create-function failed (attempt $ATTEMPT); IAM may still be propagating. Retrying in 10s."
    sleep 10
  done
  say "Created function $FUNCTION"
else
  run aws_ lambda update-function-code --function-name "$FUNCTION" --zip-file "fileb://$STAGING/mint.zip" >/dev/null
  aws_ lambda wait function-updated --function-name "$FUNCTION"
  run aws_ lambda update-function-configuration \
    --function-name "$FUNCTION" \
    --runtime "$RUNTIME" \
    --role "$ROLE_ARN" \
    --handler mint.handler \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --environment "$ENVIRONMENT" >/dev/null
  aws_ lambda wait function-updated --function-name "$FUNCTION"
  say "Updated function $FUNCTION"
fi

# -- HTTP API ------------------------------------------------------------------
CORS="{\"AllowOrigins\":[\"$APP_ORIGIN\"],\"AllowMethods\":[\"GET\",\"OPTIONS\"],\"AllowHeaders\":[\"authorization\",\"content-type\"],\"AllowCredentials\":false,\"MaxAge\":600}"
if [ -z "$API_ID" ]; then
  API_ID=$(run aws_ apigatewayv2 create-api \
    --name "$API_NAME" \
    --protocol-type HTTP \
    --description 'Coding Cube authorize-then-mint endpoint' \
    --cors-configuration "$CORS" \
    --disable-execute-api-endpoint false \
    --query ApiId --output text)
  say "Created HTTP API $API_ID"
else
  run aws_ apigatewayv2 update-api --api-id "$API_ID" --cors-configuration "$CORS" >/dev/null
  say "HTTP API $API_ID already exists; CORS updated"
fi

# The gateway's own JWT check. It is the first of two: infra/lambda/jwt.mjs verifies the same
# token again, so a route added later without this authorizer still cannot be called
# unauthenticated.
AUTHORIZER_ID=$(aws_ apigatewayv2 get-authorizers --api-id "$API_ID" \
  --query "Items[?Name=='cognito'].AuthorizerId | [0]" --output text 2>/dev/null || echo None)
[ "$AUTHORIZER_ID" = 'None' ] && AUTHORIZER_ID=''
if [ -z "$AUTHORIZER_ID" ]; then
  AUTHORIZER_ID=$(run aws_ apigatewayv2 create-authorizer \
    --api-id "$API_ID" --name cognito --authorizer-type JWT \
    --identity-source '$request.header.Authorization' \
    --jwt-configuration "Audience=$APP_CLIENT_ID,Issuer=$ISSUER" \
    --query AuthorizerId --output text)
  say "Created JWT authorizer $AUTHORIZER_ID"
else
  run aws_ apigatewayv2 update-authorizer --api-id "$API_ID" --authorizer-id "$AUTHORIZER_ID" \
    --identity-source '$request.header.Authorization' \
    --jwt-configuration "Audience=$APP_CLIENT_ID,Issuer=$ISSUER" >/dev/null
  say "JWT authorizer $AUTHORIZER_ID updated"
fi

INTEGRATION_ID=$(aws_ apigatewayv2 get-integrations --api-id "$API_ID" \
  --query "Items[?IntegrationUri=='$LAMBDA_ARN'].IntegrationId | [0]" --output text 2>/dev/null || echo None)
[ "$INTEGRATION_ID" = 'None' ] && INTEGRATION_ID=''
if [ -z "$INTEGRATION_ID" ]; then
  INTEGRATION_ID=$(run aws_ apigatewayv2 create-integration \
    --api-id "$API_ID" --integration-type AWS_PROXY \
    --integration-uri "$LAMBDA_ARN" --integration-method POST \
    --payload-format-version 2.0 \
    --query IntegrationId --output text)
  say "Created integration $INTEGRATION_ID"
else
  say "Integration $INTEGRATION_ID already exists"
fi

# Three explicit routes and no $default. An unmatched path gets a 404 from the gateway
# before it reaches anything that could be misconfigured.
for ROUTE in 'GET /session' 'GET /prepare' 'GET /mint'; do
  ROUTE_ID=$(aws_ apigatewayv2 get-routes --api-id "$API_ID" \
    --query "Items[?RouteKey=='$ROUTE'].RouteId | [0]" --output text 2>/dev/null || echo None)
  if [ "$ROUTE_ID" = 'None' ] || [ -z "$ROUTE_ID" ]; then
    run aws_ apigatewayv2 create-route --api-id "$API_ID" --route-key "$ROUTE" \
      --target "integrations/$INTEGRATION_ID" \
      --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
    say "Created route $ROUTE"
  else
    run aws_ apigatewayv2 update-route --api-id "$API_ID" --route-id "$ROUTE_ID" \
      --target "integrations/$INTEGRATION_ID" \
      --authorization-type JWT --authorizer-id "$AUTHORIZER_ID" >/dev/null
    say "Route $ROUTE updated"
  fi
done

# One line per request, with the caller's sub. This is the audit trail for "who attached to
# what and when"; the Lambda's own log is the one that says which shell.
LOG_FORMAT='{"t":"$context.requestTime","id":"$context.requestId","ip":"$context.identity.sourceIp","route":"$context.routeKey","status":"$context.status","sub":"$context.authorizer.claims.sub","latency":"$context.responseLatency","err":"$context.error.message"}'
API_LOG_ARN="arn:aws:logs:$REGION:$ACCOUNT:log-group:$API_LOG_GROUP"

STAGE_EXISTS=0
aws_ apigatewayv2 get-stage --api-id "$API_ID" --stage-name '$default' >/dev/null 2>&1 && STAGE_EXISTS=1
if [ "$STAGE_EXISTS" = 0 ]; then
  if ! run aws_ apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
    --default-route-settings "ThrottlingBurstLimit=$BURST,ThrottlingRateLimit=$RATE,DetailedMetricsEnabled=true" \
    --access-log-settings "DestinationArn=$API_LOG_ARN,Format=$LOG_FORMAT" >/dev/null 2>&1; then
    warn 'create-stage with access logging failed; creating without it. Attach logs by hand once API Gateway can write to the log group.'
    run aws_ apigatewayv2 create-stage --api-id "$API_ID" --stage-name '$default' --auto-deploy \
      --default-route-settings "ThrottlingBurstLimit=$BURST,ThrottlingRateLimit=$RATE,DetailedMetricsEnabled=true" >/dev/null
  fi
  say 'Created $default stage'
else
  run aws_ apigatewayv2 update-stage --api-id "$API_ID" --stage-name '$default' \
    --default-route-settings "ThrottlingBurstLimit=$BURST,ThrottlingRateLimit=$RATE,DetailedMetricsEnabled=true" >/dev/null
  say 'Updated $default stage'
fi

# Scoped to this API only: a bare lambda:InvokeFunction for apigateway.amazonaws.com would let
# any API in any account in the partition call this function.
aws_ lambda add-permission --function-name "$FUNCTION" \
  --statement-id "$API_NAME-invoke" --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:$REGION:$ACCOUNT:$API_ID/*/*" >/dev/null 2>&1 \
  && say 'Granted API Gateway permission to invoke the function' \
  || say 'API Gateway invoke permission already present'

ENDPOINT=$(aws_ apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint --output text)

cat <<DONE

> Ready.

  export CUBE_MINT_ORIGIN=$ENDPOINT

  This is the only value that changes in the browser. The transport, the six shellIds
  (face-1 .. face-6) and the session model are unchanged - the client swaps
  http://127.0.0.1:8787 for $ENDPOINT and adds an
  Authorization: Bearer <Cognito access token> header. Nothing else.

  Check it end to end (401 without a token, 404 with one until a workspace is provisioned):

    curl -si $ENDPOINT/session | head -1
    curl -si $ENDPOINT/session -H "Authorization: Bearer \$TOKEN" | head -1

  Function logs:  aws logs tail $LOG_GROUP --follow --region $REGION
  Access logs:    aws logs tail $API_LOG_GROUP --follow --region $REGION

Teardown:

  aws apigatewayv2 delete-api --region $REGION --api-id $API_ID
  aws lambda delete-function --region $REGION --function-name $FUNCTION
  aws iam delete-role-policy --role-name $ROLE_NAME --policy-name inline
  aws iam delete-role --role-name $ROLE_NAME
  aws logs delete-log-group --region $REGION --log-group-name $LOG_GROUP
  aws logs delete-log-group --region $REGION --log-group-name $API_LOG_GROUP

DONE
