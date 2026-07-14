#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER_NAME="${SAM3_CONTAINER_NAME:-sam3-service}"
SERVICE_URL="${SAM3_PRIMARY_SERVICE_URL:-http://127.0.0.1:8000}"
GPU_TIMEOUT_SECONDS="${SAM3_GPU_READY_TIMEOUT_SECONDS:-300}"
MODEL_TIMEOUT_SECONDS="${SAM3_MODEL_READY_TIMEOUT_SECONDS:-300}"
POLL_INTERVAL_SECONDS="${SAM3_READY_POLL_INTERVAL_SECONDS:-5}"

log() {
  printf '[sam3-gpu-ready] %s\n' "$*"
}

wait_until() {
  local timeout_seconds="$1"
  local description="$2"
  shift 2

  local deadline=$((SECONDS + timeout_seconds))
  until "$@"; do
    if (( SECONDS >= deadline )); then
      log "Timed out waiting for ${description} after ${timeout_seconds}s"
      return 1
    fi
    sleep "$POLL_INTERVAL_SECONDS"
  done
}

host_gpu_ready() {
  nvidia-smi -L >/dev/null 2>&1
}

container_exists() {
  docker inspect "$CONTAINER_NAME" >/dev/null 2>&1
}

container_cuda_ready() {
  docker exec "$CONTAINER_NAME" python3 -c \
    'import torch; raise SystemExit(0 if torch.cuda.is_available() and torch.cuda.device_count() > 0 else 1)' \
    >/dev/null 2>&1
}

model_ready() {
  curl --fail --silent --show-error --max-time 5 \
    "${SERVICE_URL}/api/v1/status" |
    python3 -c \
      'import json, sys; data = json.load(sys.stdin); raise SystemExit(0 if data.get("predictor", {}).get("model_loaded") is True and data.get("device") == "cuda" else 1)' \
    >/dev/null 2>&1
}

main() {
  log "Waiting for the host NVIDIA runtime"
  wait_until "$GPU_TIMEOUT_SECONDS" "host NVIDIA runtime" host_gpu_ready || return 1

  log "Waiting for Docker container ${CONTAINER_NAME}"
  wait_until "$GPU_TIMEOUT_SECONDS" "Docker container ${CONTAINER_NAME}" container_exists || return 1

  if [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME")" == "true" ]]; then
    log "Restarting ${CONTAINER_NAME} after CUDA became available"
    docker restart "$CONTAINER_NAME" >/dev/null
  else
    log "Starting ${CONTAINER_NAME} after CUDA became available"
    docker start "$CONTAINER_NAME" >/dev/null
  fi

  log "Verifying CUDA from inside ${CONTAINER_NAME}"
  wait_until "$GPU_TIMEOUT_SECONDS" "container CUDA visibility" container_cuda_ready || return 1

  log "Waiting for the primary SAM3 model"
  wait_until "$MODEL_TIMEOUT_SECONDS" "primary SAM3 model" model_ready || return 1

  log "Primary SAM3 is ready on CUDA"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
