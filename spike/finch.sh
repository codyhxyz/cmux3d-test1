#!/bin/sh
# Phase 0 driver. Everything here is local and free except `push`, which is
# marked and gated because it mutates AWS.
set -eu

REPO_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
IMAGE=${CUBE_IMAGE:-coding-cube-spike:dev}
CONTAINER=${CUBE_CONTAINER:-coding-cube-spike}
PORT=${CUBE_PORT:-8080}
# Finch's Lima VM shares $HOME by default; /tmp on the host is not guaranteed to
# be visible inside the VM, so the stand-in for session storage lives under HOME.
MOUNT=${CUBE_MOUNT:-$HOME/.coding-cube-spike/workspace}
# The AgentCore cap is a hard 2 GB. Fail early enough to still have room to fix it.
SIZE_LIMIT=${CUBE_SIZE_LIMIT:-1800000000}
ECR_ACCOUNT=${CUBE_ECR_ACCOUNT:-808175385344}
ECR_REGION=${CUBE_ECR_REGION:-us-east-1}
ECR_REPO=${CUBE_ECR_REPO:-coding-cube-spike}
ECR_TAG=${CUBE_ECR_TAG:-v1}

die() {
  echo "finch.sh: $1" >&2
  exit 1
}

preflight() {
  if ! command -v finch >/dev/null 2>&1; then
    echo 'finch is not installed. This script will not install it for you:' >&2
    echo '' >&2
    echo '  brew install --cask finch && finch vm init && finch vm start' >&2
    echo '' >&2
    exit 1
  fi
  if ! finch vm status 2>/dev/null | grep -qi running; then
    echo 'the finch vm is not running:' >&2
    echo '' >&2
    echo '  finch vm init && finch vm start' >&2
    echo '' >&2
    exit 1
  fi
}

image_size_bytes() {
  size=$(finch image inspect --format '{{.Size}}' "$IMAGE" 2>/dev/null || true)
  case $size in
    '' | *[!0-9]*) ;;
    *) printf '%s\n' "$size"; return 0 ;;
  esac
  # Older nerdctl only reports a human-readable size, e.g. "1.1GiB".
  size=$(finch images --format '{{.Size}}' "$IMAGE" 2>/dev/null | head -n 1)
  [ -n "$size" ] || return 1
  printf '%s\n' "$size" | awk '{
    n = $0; sub(/[A-Za-z ]+$/, "", n);
    u = toupper(substr($0, length(n) + 1));
    m = 1;
    if (u ~ /^K/) m = 1024;
    else if (u ~ /^M/) m = 1048576;
    else if (u ~ /^G/) m = 1073741824;
    else if (u ~ /^T/) m = 1099511627776;
    printf "%d\n", n * m;
  }'
}

cmd_size() {
  preflight
  bytes=$(image_size_bytes) || die "could not measure $IMAGE — build it first"
  awk -v bytes="$bytes" -v limit="$SIZE_LIMIT" 'BEGIN {
    printf "image size: %.2f GB (%d bytes)\n", bytes / 1000000000, bytes;
    if (bytes > limit) {
      printf "OVER BUDGET: %.2f GB allowed here, 2 GB is the AgentCore hard cap\n",
        limit / 1000000000;
      print "levers: prune more of node_modules, or drop a global agent package";
      exit 1;
    }
  }'
  layers=$(finch image inspect --format '{{len .RootFS.Layers}}' "$IMAGE" 2>/dev/null || true)
  case $layers in
    '' | *[!0-9]*) echo 'layer count: unavailable (nerdctl did not report RootFS)' ;;
    *)
      echo "layers: $layers"
      [ "$layers" -lt 53 ] || die 'over 53 layers — AgentCore returns HTTP 424 "Failed to mount overlay"'
      ;;
  esac
}

cmd_build() {
  preflight
  finch build \
    --platform linux/arm64 \
    -t "$IMAGE" \
    -f "$REPO_ROOT/spike/Dockerfile" \
    "$REPO_ROOT"
  cmd_size
}

cmd_run() {
  preflight
  mkdir -p "$MOUNT"
  finch rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "mount: $MOUNT -> /mnt/workspace"
  exec finch run --rm -it \
    --name "$CONTAINER" \
    -p "$PORT:8080" \
    -v "$MOUNT:/mnt/workspace" \
    -e CODING_CUBE_SPIKE=1 \
    -e CODING_CUBE_GATEWAY_ONLY=1 \
    "$IMAGE" "$@"
}

cmd_start() {
  preflight
  mkdir -p "$MOUNT"
  finch rm -f "$CONTAINER" >/dev/null 2>&1 || true
  finch run -d \
    --name "$CONTAINER" \
    -p "$PORT:8080" \
    -v "$MOUNT:/mnt/workspace" \
    -e CODING_CUBE_SPIKE=1 \
    -e CODING_CUBE_GATEWAY_ONLY=1 \
    "$IMAGE" >/dev/null
  echo "mount: $MOUNT -> /mnt/workspace"
  echo "ping:  curl -s http://127.0.0.1:$PORT/ping"
  echo "logs:  spike/finch.sh logs"
}

# T-04: the same bind mount across a full container replacement is the whole test.
cmd_restart() {
  preflight
  finch rm -f "$CONTAINER" >/dev/null 2>&1 || true
  cmd_start
}

cmd_logs() {
  preflight
  finch logs -f "$CONTAINER"
}

cmd_shell() {
  preflight
  exec finch exec -it "$CONTAINER" /bin/bash
}

cmd_stop() {
  preflight
  finch rm -f "$CONTAINER" >/dev/null 2>&1 || true
  echo "stopped $CONTAINER (the mount at $MOUNT is untouched)"
}

cmd_wipe() {
  [ -n "$MOUNT" ] || die 'MOUNT is empty'
  printf 'delete %s and everything in it? type WIPE: ' "$MOUNT"
  read -r answer
  [ "$answer" = 'WIPE' ] || die 'aborted'
  rm -rf "$MOUNT"
  echo "removed $MOUNT"
}

cmd_push() {
  preflight
  command -v aws >/dev/null 2>&1 || die 'the aws cli is not installed'
  registry="$ECR_ACCOUNT.dkr.ecr.$ECR_REGION.amazonaws.com"
  remote="$registry/$ECR_REPO:$ECR_TAG"
  # create-repository writes to whatever account the ambient credentials resolve
  # to, not to $ECR_ACCOUNT — without this the first mutation can land in a
  # production account and only the later `finch login` would fail.
  caller=$(aws sts get-caller-identity --query Account --output text 2>/dev/null) \
    || die 'no usable AWS credentials (aws sts get-caller-identity failed)'
  [ "$caller" = "$ECR_ACCOUNT" ] \
    || die "credentials are for account $caller but the registry is $ECR_ACCOUNT. Set CUBE_ECR_ACCOUNT=$caller, or switch AWS_PROFILE."
  cat <<BANNER

  !! AWS MUTATION !!  This creates an ECR repository and uploads the image.

    account:  $ECR_ACCOUNT ($ECR_REGION)
    registry: $registry

    aws ecr create-repository --repository-name $ECR_REPO --region $ECR_REGION
    aws ecr get-login-password --region $ECR_REGION | finch login --username AWS --password-stdin $registry
    finch tag $IMAGE $remote
    finch push $remote

BANNER
  printf 'type PUSH to run them: '
  read -r answer
  [ "$answer" = 'PUSH' ] || die 'aborted'
  # Tolerate only "it already exists"; anything else is a real failure and used
  # to be swallowed by `|| true`.
  if ! created=$(aws ecr create-repository --repository-name "$ECR_REPO" --region "$ECR_REGION" 2>&1); then
    case $created in
      *RepositoryAlreadyExistsException*) echo "ecr repository $ECR_REPO already exists in $ECR_ACCOUNT" ;;
      *) die "aws ecr create-repository failed: $created" ;;
    esac
  fi
  aws ecr get-login-password --region "$ECR_REGION" \
    | finch login --username AWS --password-stdin "$registry"
  finch tag "$IMAGE" "$remote"
  finch push "$remote"
  echo "pushed $remote"
}

usage() {
  cat <<USAGE
usage: spike/finch.sh <command>

  build      build $IMAGE for linux/arm64, then check size and layer count
  size       measure an already-built image against the 2 GB cap
  run        run in the foreground with a bind mount standing in for /mnt/workspace
  start      same, detached
  restart    replace the container against the SAME mount (T-04, restore-after-restart)
  logs       follow the detached container's log
  shell      bash inside the running container
  stop       remove the container, keep the mount
  wipe       delete the bind mount (destructive, asks first)
  push       AWS MUTATION: create the ECR repo and push the image (asks first)

env: CUBE_IMAGE CUBE_CONTAINER CUBE_PORT CUBE_MOUNT CUBE_SIZE_LIMIT
     CUBE_ECR_ACCOUNT CUBE_ECR_REGION CUBE_ECR_REPO CUBE_ECR_TAG

mount: $MOUNT
USAGE
}

command=${1:-}
[ $# -gt 0 ] && shift

case $command in
  build) cmd_build "$@" ;;
  size) cmd_size "$@" ;;
  run) cmd_run "$@" ;;
  start) cmd_start "$@" ;;
  restart) cmd_restart "$@" ;;
  logs) cmd_logs "$@" ;;
  shell) cmd_shell "$@" ;;
  stop) cmd_stop "$@" ;;
  wipe) cmd_wipe "$@" ;;
  push) cmd_push "$@" ;;
  '' | -h | --help | help) usage ;;
  *) usage; exit 64 ;;
esac
