# Pine Stocktake v1 local evidence

This report records implementation and bounded infrastructure-readiness evidence. No production mission, inference batch, deployment, merge, or external data write was performed. On 2026-08-18, one stopped GPU fallback was started for the readiness checks below and stopped after the checks.

## Source identities

- AgriDrone Ops base: `83a221808f3e77d15f9dca5d72d2cfffdbc1648c` from `origin/main`.
- Branch: `codex/agri-pine-stocktake`.
- Worktree: `/Users/bensbigmac/agri-drone-ops-pine-stocktake`.
- Reference logic: the eight named modules in `/Users/bensbigmac/forestry-worker-hqp-pointcloud-labeler`; no runtime dependency was added.
- Flat Map Runner: validated at local commit `824cf071c7220f831cf3352111a43caddf8f25c8`, archive SHA-256 `6c35112fe4c0b70d8018f3133ac562e3e9ca37f64cbaa970e48e624c17ab337d`; the checkout was clean and one unpushed commit ahead of its remote.

## Verification scope

The focused tests use a small sealed HQP fixture. Its 8 existing-stock merges, 20 new-cluster review items, 4 ambiguous records, and 130 no-coverage exceptions are regression evidence. They are not performance targets.

CI model execution is mocked. Coordinate transforms, calibration parsing, mask agreement, review lineage, LiDAR cluster selection, recovery decisions, deduplication, and stored-result exports remain real calculations.

Final local results on 2026-08-17:

- Prisma schema validation: PASS.
- Prisma client generation: PASS.
- Python service syntax compilation: PASS.
- Repository unit tests: PASS, 22 files and 174 tests.
- Sealed Pine Stocktake integration: PASS, 2 tests with real geometry, calibration, review, clustering, recovery, deduplication, and export logic.
- Chromium operator journey: PASS, 1 test covering mission association, third-exemplar approval, detection queue, review, rapid map, calibrated LiDAR queue, projected overlay, and exports.
- Next.js production build: PASS, 102 pages generated.
- Pine Stocktake filtered type check: PASS, no Pine Stocktake diagnostics.
- Repository-wide standalone type check: NOT PASS due to existing unrelated errors; see validation limits.

## Shared GPU readiness evidence

Bounded live checks on 2026-08-18 used the configured AgriDrone GPU pool. AWS could not start the preferred `g5.2xlarge` because the availability zone returned `InsufficientInstanceCapacity`. The configured private fallback `i-0644d9ad40d75e0b8` (`g4dn.4xlarge`, Tesla T4) started successfully.

- SAM3 service: PASS on port 8000, CUDA available.
- Repository and revision: PASS, cached `facebook/sam3` revision `3c879f39826c281e95690f02c7821c4de09afae7`.
- SAM3 weight: PASS, `model.safetensors` SHA-256 independently calculated as `6d06f0a5f84e435071fe6603e61d0b4cc7b40e0d39d487cfd4d67d8cc11cc14a`.
- YOLO service: PASS on port 8001, CUDA available.
- Pine YOLO model: PASS, `pine-saplings-yolo11n-seg-glasshouse-v1` completed a real inference and entered the service cache.
- Pine YOLO weight SHA-256: `a2d3b6e15285d4964e6267d983350cbd0a8ed0dcdb64e03d92ace03ab4b18a45`.
- VPC path: PASS. The running AgriDrone application host reached the fallback at `172.31.19.222` on ports 8000 and 8001.
- Focused lifecycle and inference tests after the repair: PASS, 4 files and 26 tests.
- Focused lint: PASS for the changed AWS, YOLO, and test files.

The repair adds `YOLO_USE_SAM3_INSTANCE_POOL=true`. With this flag, fixed YOLO URLs are ignored, a YOLO request starts the configured GPU pool, and the service is discovered on port 8001. EC2 discovery now permits the private address of a private-only fallback. The flag is not enabled in production until this branch is reviewed and deployed.

## Local validation limits

- The bounded GPU check proved the pinned SAM3 cache and the existing SAM3 and YOLO endpoints. The Pine Stocktake browser test still mocks full native mission execution. The live GPU image does not yet contain this branch's `/api/v1/pine-stocktake` endpoint.
- The Flat Map and calibrated LiDAR workers are identity-checked job contracts. No remote runner job or production LiDAR mapping run was started.
- The production PM2 process list starts the Pine Stocktake BullMQ worker. Flat Map and calibrated LiDAR stages still require reachable, identity-pinned service deployments before the production workflow can be declared operational.
- The application build succeeds because the existing Next.js configuration skips type validation. The standalone repository type check has pre-existing errors outside Pine Stocktake. A filtered check reports no Pine Stocktake errors. Fixing unrelated type debt would require a broader AgriDrone change and is outside this branch.
