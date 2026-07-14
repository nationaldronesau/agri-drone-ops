# SAM3 GPU cold-start guard

`sam3-gpu-ready.service` fixes the EC2 stop/start race where Docker can restore
`sam3-service` before the NVIDIA runtime is usable. In that state the host GPU
is healthy, but PyTorch inside the restored container reports zero CUDA devices
until the container is restarted.

The guard runs once per boot and:

1. waits for `nvidia-smi` on the host;
2. waits for Docker to restore the existing `sam3-service` container;
3. restarts the container after CUDA is available;
4. verifies CUDA from PyTorch inside the container;
5. waits for `/api/v1/status` to report the primary SAM3 model loaded on CUDA.

It is ordered before `sam3-concept.service`, so the primary and concept models
do not race to initialise the GPU during boot.

Install without interrupting the current service:

```bash
sudo ./install-startup-guard.sh
```

Install and run the guard immediately:

```bash
sudo ./install-startup-guard.sh --start
```

The installer is idempotent. Verify it with:

```bash
systemctl status sam3-gpu-ready.service
journalctl -u sam3-gpu-ready.service -b
```
