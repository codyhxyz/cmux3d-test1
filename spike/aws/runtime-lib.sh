#!/bin/sh
# Shared AgentCore provisioning lifecycle. Callers own configuration assembly, diagnostics,
# confirmation and teardown; this file only owns the byte-identical create/update/wait loop.

runtime_version_ge() {
  awk -v have="$1" -v want="$2" '
    function num(v,  p) { split(v, p, "."); return p[1] * 1000000 + p[2] * 1000 + p[3] }
    BEGIN { exit !(num(have) >= num(want)) }
  '
}

runtime_wait_ready() {
  runtime_wait_id=$1
  runtime_wait_attempt=0
  while [ "$runtime_wait_attempt" -lt 60 ]; do
    runtime_wait_state=$(aws_ bedrock-agentcore-control get-agent-runtime \
      --agent-runtime-id "$runtime_wait_id" --query status --output text 2>/dev/null || echo UNKNOWN)
    case "$runtime_wait_state" in
      READY) return 0 ;;
      CREATE_FAILED|UPDATE_FAILED)
        runtime_wait_reason=$(aws_ bedrock-agentcore-control get-agent-runtime \
          --agent-runtime-id "$runtime_wait_id" --query failureReason --output text 2>/dev/null || true)
        if [ -n "${RUNTIME_FAILURE_HINT:-}" ]; then
          die "Runtime $runtime_wait_id is $runtime_wait_state ($runtime_wait_reason). $RUNTIME_FAILURE_HINT"
        fi
        die "runtime $runtime_wait_id is $runtime_wait_state ($runtime_wait_reason)"
        ;;
      DELETING)
        if [ -n "${RUNTIME_FAILURE_HINT:-}" ]; then
          die "Runtime $runtime_wait_id is DELETING. Wait for it to disappear, then re-run."
        fi
        die "runtime $runtime_wait_id is DELETING; wait for it to disappear, then re-run"
        ;;
    esac
    runtime_wait_attempt=$((runtime_wait_attempt + 1))
    sleep 5
  done
  if [ -n "${RUNTIME_FAILURE_HINT:-}" ]; then
    die "Runtime $runtime_wait_id never reached READY."
  fi
  die "runtime $runtime_wait_id never reached READY"
}

runtime_create_with_retry() {
  runtime_create_name=$1
  shift
  runtime_create_attempt=0
  while :; do
    if RUNTIME_ID=$(run aws_ bedrock-agentcore-control create-agent-runtime \
      --agent-runtime-name "$runtime_create_name" "$@" \
      --query agentRuntimeId --output text); then
      break
    fi
    RUNTIME_ID=''
    runtime_create_attempt=$((runtime_create_attempt + 1))
    [ "$runtime_create_attempt" -lt 5 ] \
      || die "${RUNTIME_CREATE_FAILURE:-create-agent-runtime kept failing}"
    warn "create-agent-runtime failed (attempt $runtime_create_attempt); IAM may still be propagating. Retrying in 10s."
    sleep 10
  done
  say "Created runtime $RUNTIME_ID"
  runtime_wait_ready "$RUNTIME_ID"
}

runtime_enable_mmdsv2() {
  runtime_update_id=$1
  shift
  run aws_ bedrock-agentcore-control update-agent-runtime \
    --agent-runtime-id "$runtime_update_id" "$@" \
    --metadata-configuration "$METADATA" >/dev/null
  say 'Enabled MMDSv2'
  runtime_wait_ready "$runtime_update_id"
}
