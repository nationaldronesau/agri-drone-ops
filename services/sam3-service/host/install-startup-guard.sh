#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this installer as root.\n' >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "${SCRIPT_DIR}/sam3-gpu-ready.sh" /usr/local/sbin/sam3-gpu-ready
install -m 0644 "${SCRIPT_DIR}/sam3-gpu-ready.service" /etc/systemd/system/sam3-gpu-ready.service

systemctl daemon-reload
systemctl enable sam3-gpu-ready.service

if [[ "${1:-}" == "--start" ]]; then
  systemctl restart sam3-gpu-ready.service
fi

printf 'Installed and enabled sam3-gpu-ready.service\n'
