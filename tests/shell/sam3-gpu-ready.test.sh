#!/usr/bin/env bash
set -Eeuo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=../../services/sam3-service/host/sam3-gpu-ready.sh
source "${REPO_ROOT}/services/sam3-service/host/sam3-gpu-ready.sh"

events=""

record() {
  events="${events}${events:+,}$1"
}

host_gpu_ready() {
  record host-gpu
}

container_exists() {
  record container-exists
}

container_cuda_ready() {
  record container-cuda
}

model_ready() {
  record model-ready
}

docker() {
  if [[ "$1" == "inspect" && "$2" == "--format" ]]; then
    record inspect-running
    printf 'true\n'
    return
  fi

  if [[ "$1" == "restart" && "$2" == "sam3-service" ]]; then
    record restart
    return
  fi

  printf 'Unexpected docker call: %s\n' "$*" >&2
  return 1
}

GPU_TIMEOUT_SECONDS=1
MODEL_TIMEOUT_SECONDS=1
POLL_INTERVAL_SECONDS=0

main >/dev/null

expected="host-gpu,container-exists,restart,container-cuda,model-ready"
if [[ "$events" != "$expected" ]]; then
  printf 'Expected event order %s, got %s\n' "$expected" "$events" >&2
  exit 1
fi

events=""
host_gpu_ready() {
  record host-not-ready
  return 1
}
GPU_TIMEOUT_SECONDS=0

if main >/dev/null 2>&1; then
  printf 'Expected the guard to fail when the host GPU never becomes ready\n' >&2
  exit 1
fi

if [[ "$events" != "host-not-ready" ]]; then
  printf 'Guard continued past the failed host readiness gate: %s\n' "$events" >&2
  exit 1
fi

printf 'sam3-gpu-ready tests passed\n'
