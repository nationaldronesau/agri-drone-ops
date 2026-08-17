# Pine Stocktake v1 local evidence

This report records local implementation evidence only. No production mission, cloud job, deployment, push, merge, AWS change, or external data write was performed.

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

## Local validation limits

- The SAM3 end-to-end browser test mocks GPU execution. The pinned service lane compiles, but no full native mission or paid compute was started.
- The Flat Map and calibrated LiDAR workers are identity-checked job contracts. No remote runner job or production LiDAR mapping run was started.
- The production PM2 process list starts the Pine Stocktake BullMQ worker. Flat Map and calibrated LiDAR stages still require reachable, identity-pinned service deployments before the production workflow can be declared operational.
- The application build succeeds because the existing Next.js configuration skips type validation. The standalone repository type check has pre-existing errors outside Pine Stocktake. A filtered check reports no Pine Stocktake errors. Fixing unrelated type debt would require a broader AgriDrone change and is outside this branch.
