#!/bin/sh
# Cognito user pool + app client for multi-user Coding Cube. EVERY STEP MUTATES AWS.
# Re-running is safe; the teardown it prints is not.
#
# Why Cognito and not "just a JWT": the mint Lambda needs an issuer whose signing keys it can
# fetch and rotate without shipping a secret to the browser, and the HTTP API needs a JWT
# authorizer it can verify natively. Cognito gives both for free at this scale.
#
# The pool is INVITE ONLY (AllowAdminCreateUserOnly=true) on purpose. Every signup costs an
# agent runtime out of a quota of 100, so self-service registration would let a stranger
# exhaust the account. Provisioning is a deliberate second step:
#   sh spike/aws/create-user-workspace.sh
set -eu

REGION="${CUBE_REGION:-us-east-1}"
ACCOUNT="${CUBE_ACCOUNT:-808175385344}"
POOL_NAME="${CUBE_POOL_NAME:-coding-cube}"
CLIENT_NAME="${CUBE_CLIENT_NAME:-coding-cube-web}"
# ESSENTIALS is the AWS default and the tier managed login requires. LITE is cheaper and
# enough if you build your own sign-in page.
TIER="${CUBE_POOL_TIER:-ESSENTIALS}"
# Where the Cube itself is served from. Becomes the OAuth callback and, later, the only
# origin the mint API answers.
APP_ORIGIN="${CUBE_APP_ORIGIN:-https://codingcube.codyh.xyz}"
# Optional hosted-UI prefix, e.g. coding-cube-auth -> coding-cube-auth.auth.us-east-1.amazoncognito.com
DOMAIN_PREFIX="${CUBE_COGNITO_DOMAIN:-}"
# Access tokens are the credential the browser presents to the mint API on every reconnect.
# 60 minutes is the Cognito maximum for a short-lived token and still comfortably longer than
# a 300-second presigned URL, so a face never fails to re-mint mid-session.
ACCESS_MINUTES="${CUBE_ACCESS_TOKEN_MINUTES:-60}"
REFRESH_DAYS="${CUBE_REFRESH_TOKEN_DAYS:-30}"

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
CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
  || die 'no usable AWS credentials'
[ "$CALLER" = "$ACCOUNT" ] \
  || die "credentials are for account $CALLER but this script targets $ACCOUNT"

case "$APP_ORIGIN" in
  https://*) ;;
  http://localhost*|http://127.0.0.1*) warn "$APP_ORIGIN is loopback; Cognito allows it for development only" ;;
  *) die "CUBE_APP_ORIGIN must be https (or a loopback dev URL); got $APP_ORIGIN" ;;
esac

POOL_ID=$(aws_ cognito-idp list-user-pools --max-results 60 \
  --query "UserPools[?Name=='$POOL_NAME'].Id | [0]" --output text 2>/dev/null || echo None)
[ "$POOL_ID" = 'None' ] && POOL_ID=''

cat <<PLAN

  Plan - account $ACCOUNT, region $REGION

    User pool       $POOL_NAME  ($TIER, invite only, email sign-in)   $([ -n "$POOL_ID" ] && echo "exists as $POOL_ID, skip" || echo CREATE)
    MFA             OPTIONAL, software token (TOTP)
    App client      $CLIENT_NAME  (public, no secret, SRP + refresh, PKCE code flow)
    Token validity  access ${ACCESS_MINUTES}m, id ${ACCESS_MINUTES}m, refresh ${REFRESH_DAYS}d
    Callback        $APP_ORIGIN
    Hosted domain   $([ -n "$DOMAIN_PREFIX" ] && echo "$DOMAIN_PREFIX" || echo 'none (set CUBE_COGNITO_DOMAIN to add one)')

  Cost: user-pool sign-in is free for the first 10,000 monthly active users; beyond that it
  is a fraction of a cent per MAU. Nothing here has a standing charge.

PLAN

[ "$DRY_RUN" = 1 ] && { say 'Dry run - nothing was changed.'; exit 0; }
[ -t 0 ] || die 'Refusing to mutate AWS without a terminal to confirm from. Use --dry-run.'
printf 'This mutates AWS. Type exactly: create identity %s\n> ' "$POOL_NAME"
read -r ANSWER
[ "$ANSWER" = "create identity $POOL_NAME" ] || die 'aborted'

# -- user pool -----------------------------------------------------------------
if [ -z "$POOL_ID" ]; then
  POOL_ID=$(run aws_ cognito-idp create-user-pool \
    --pool-name "$POOL_NAME" \
    --user-pool-tier "$TIER" \
    --username-attributes email \
    --auto-verified-attributes email \
    --deletion-protection ACTIVE \
    --admin-create-user-config 'AllowAdminCreateUserOnly=true' \
    --account-recovery-setting 'RecoveryMechanisms=[{Name=verified_email,Priority=1}]' \
    --policies 'PasswordPolicy={MinimumLength=12,RequireUppercase=true,RequireLowercase=true,RequireNumbers=true,RequireSymbols=false,TemporaryPasswordValidityDays=7}' \
    --query 'UserPool.Id' --output text)
  say "Created user pool $POOL_ID"
else
  say "User pool $POOL_NAME already exists as $POOL_ID"
fi

# MFA cannot be set to OPTIONAL at create time without a configured factor, so it is a
# second call. TOTP only: SMS needs an SNS role and costs money per message.
run aws_ cognito-idp set-user-pool-mfa-config \
  --user-pool-id "$POOL_ID" \
  --software-token-mfa-configuration 'Enabled=true' \
  --mfa-configuration OPTIONAL >/dev/null
say 'MFA is OPTIONAL with software tokens enabled'

# -- app client ----------------------------------------------------------------
# No client secret: this is a browser SPA, so a secret would be published with the page.
# PKCE on the authorization-code flow is what replaces it. USER_PASSWORD_AUTH is deliberately
# absent — it sends the password to the API in cleartext-over-TLS instead of using SRP.
CLIENT_ID=$(aws_ cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" --max-results 60 \
  --query "UserPoolClients[?ClientName=='$CLIENT_NAME'].ClientId | [0]" --output text 2>/dev/null || echo None)
[ "$CLIENT_ID" = 'None' ] && CLIENT_ID=''

if [ -z "$CLIENT_ID" ]; then
  CLIENT_ID=$(run aws_ cognito-idp create-user-pool-client \
    --user-pool-id "$POOL_ID" \
    --client-name "$CLIENT_NAME" \
    --no-generate-secret \
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --prevent-user-existence-errors ENABLED \
    --enable-token-revocation \
    --supported-identity-providers COGNITO \
    --allowed-o-auth-flows code \
    --allowed-o-auth-flows-user-pool-client \
    --allowed-o-auth-scopes openid email profile \
    --callback-urls "$APP_ORIGIN" \
    --logout-urls "$APP_ORIGIN" \
    --access-token-validity "$ACCESS_MINUTES" \
    --id-token-validity "$ACCESS_MINUTES" \
    --refresh-token-validity "$REFRESH_DAYS" \
    --token-validity-units 'AccessToken=minutes,IdToken=minutes,RefreshToken=days' \
    --query 'UserPoolClient.ClientId' --output text)
  say "Created app client $CLIENT_ID"
else
  say "App client $CLIENT_NAME already exists as $CLIENT_ID"
  warn "Not overwriting its settings. Delete it and re-run if $APP_ORIGIN is not already a callback URL."
fi

# -- hosted UI domain (optional) -----------------------------------------------
if [ -n "$DOMAIN_PREFIX" ]; then
  EXISTING=$(aws_ cognito-idp describe-user-pool --user-pool-id "$POOL_ID" \
    --query 'UserPool.Domain' --output text 2>/dev/null || echo None)
  if [ "$EXISTING" = 'None' ] || [ -z "$EXISTING" ]; then
    run aws_ cognito-idp create-user-pool-domain --user-pool-id "$POOL_ID" --domain "$DOMAIN_PREFIX" >/dev/null
    say "Created hosted UI domain $DOMAIN_PREFIX"
  else
    say "Hosted UI domain already exists as $EXISTING"
    DOMAIN_PREFIX="$EXISTING"
  fi
fi

ISSUER="https://cognito-idp.$REGION.amazonaws.com/$POOL_ID"

cat <<DONE

> Ready.

  export CUBE_USER_POOL_ID=$POOL_ID
  export CUBE_APP_CLIENT_ID=$CLIENT_ID
  export CUBE_ISSUER=$ISSUER
  export CUBE_APP_ORIGIN=$APP_ORIGIN

  JWKS (what the mint Lambda verifies against):
    $ISSUER/.well-known/jwks.json

  Invite a user - this does NOT give them a workspace:

    aws cognito-idp admin-create-user --region $REGION --user-pool-id $POOL_ID \\
      --username someone@example.com --user-attributes Name=email,Value=someone@example.com Name=email_verified,Value=true

  Then provision their workspace, which is what actually costs an agent runtime:

    CUBE_USER_EMAIL=someone@example.com sh spike/aws/create-user-workspace.sh

Teardown - DESTRUCTIVE, deletes every account in the pool:

  aws cognito-idp update-user-pool --region $REGION --user-pool-id $POOL_ID --deletion-protection INACTIVE
  aws cognito-idp delete-user-pool --region $REGION --user-pool-id $POOL_ID

DONE
