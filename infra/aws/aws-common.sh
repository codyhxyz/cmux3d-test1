#!/bin/sh
# Shared, POSIX-safe preflight for AWS provisioning scripts. Source this after setting
# REGION and ACCOUNT. `die` deliberately stays overridable by scripts with teardown hooks.

say() { printf '\033[36m>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!\033[0m %s\n' "$1" >&2; }
die() { printf '\033[31mx\033[0m %s\n' "$1" >&2; exit 1; }
# Trace to stderr so run remains safe in command substitutions.
run() { printf '\033[35m$\033[0m %s\n' "$*" >&2; "$@"; }
aws_() { aws --region "$REGION" "$@"; }

aws_common_parse_dry_run() {
  DRY_RUN=0
  case "${1:-}" in
    --dry-run|--plan) DRY_RUN=1 ;;
    '') ;;
    *) printf 'usage: %s [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
}

aws_verify_account() {
  command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
  CALLER=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
    || die 'no usable AWS credentials'
  [ "$CALLER" = "$ACCOUNT" ] \
    || die "credentials are for account $CALLER but this script targets $ACCOUNT"
}
