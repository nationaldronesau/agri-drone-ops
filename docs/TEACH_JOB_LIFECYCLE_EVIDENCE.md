# Teach AI job lifecycle evidence

Date: 13 July 2026
Branch: `codex/agri-teach-job-lifecycle`

## Verified model route

The guided Teach workspace submits `concept_propagation` jobs to `POST /api/sam3/v2/batch`.

That V2 service calls `awsSam3Service` directly. For concept propagation it:

1. warms the concept service;
2. creates one concept exemplar per operator-drawn source box;
3. applies those exemplars to each target image;
4. refines returned candidate boxes with SAM3 box prompts when possible; and
5. persists every result as a review suggestion.

The concept service uses `SAM3_CONCEPT_PORT`, defaulting to port `8002`, and calls `/warmup`, `/api/v1/exemplars/create`, and `/api/v1/exemplars/apply`. Warm-up reports both `sam3_loaded` and `dino_loaded`.

The repository also contains a separate Roboflow SAM3 orchestrator, but the V2 batch service does not import or call it. There is no YOLO or Roboflow provider fallback in the Teach V2 batch route.

## Recovery behaviour

Two same-pipeline recovery paths exist and are now reported separately:

- **Candidate expansion:** SAM3 + DINO reruns concept matching with the lower-threshold high-recall profile when strict matching returns too few candidates.
- **Unrefined candidate preservation:** if SAM3 box refinement fails, the concept candidates can still be preserved as pending review suggestions with an explicit warning.

Neither path changes to YOLO or Roboflow. Neither path bypasses human review.

## Implemented lifecycle

- Teach stores the submitted batch ID, project, target, poll URL, and submission time in same-origin local storage.
- A queued or processing job restores after page refresh and resumes polling.
- The operator sees processed images, suggestion count, translated processing stage, connection failures, and terminal failures.
- Technical details expose the recorded model route, review profile, runtime evidence, and any same-model recovery.
- A completed job creates or reuses a review session scoped to that exact batch ID and navigates to `/review?sessionId=...`.
- Project, target, source image, examples, and filmstrip controls stay locked while a saved job is active so the UI cannot imply that a submitted job has changed.
- Operators can discard an inaccessible saved job or start again after completion or failure.

## Verification completed

- Focused lifecycle and SAM3 tests: 23 passed.
- Full unit suite: 82 passed across 15 files.
- Production build with `NEXT_PUBLIC_GUIDED_OPERATOR_FLOW=true`: passed.
- Changed implementation files: no TypeScript errors when filtered from `tsc --noEmit`.
- Full repository TypeScript check: still fails on pre-existing route, Prisma JSON, EXIF, and generated Next route-type errors outside this change.
- In-app browser: `/teach?demo=1` rendered successfully with the approved filmstrip layout, safety boundary, existing navigation, no visible layout regression, and no warnings or errors in a fresh stable tab.
- Automated browser specifications were added for submit, poll, refresh restore, exact review-session payload/navigation, and inaccessible-job recovery. They require the repository's Playwright runner and were not executed during this pass.

## Proof boundary

This branch proves the application contracts locally. It does **not** prove a live GPU worker is currently healthy because the local environment has no `SAM3_INSTANCE_ID`, and no real customer batch was executed. A post-deploy authenticated canary batch is still required to prove live SAM3 + DINO runtime behaviour end to end.
