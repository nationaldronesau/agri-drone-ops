import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { S3Service } from '@/lib/services/s3';
import {
  FLAT_MAP_RUNNER_IDENTITY,
  PINE_STOCKTAKE_CONFIG,
  PINE_STOCKTAKE_METHOD,
  SAM3_IDENTITY,
  assertThreeExternalExemplars,
  assertPinnedModel,
  parseClc,
  parseCli,
  selectProjectedCrs,
  validateCameraSerials,
} from '@/lib/pine-stocktake/core';
import type {
  PineStocktakeJobData,
  PineStocktakeJobResult,
} from '@/lib/queue/pine-stocktake-queue';

const pineJobInclude = Prisma.validator<Prisma.PineStocktakeJobInclude>()({
  missionFiles: { include: { asset: true } },
  exemplars: { include: { sourceAsset: true } },
  acceptedCrowns: true,
});
type PineJobRecord = Prisma.PineStocktakeJobGetPayload<{ include: typeof pineJobInclude }>;

export interface MissionFileInput {
  kind: 'IMAGE_LV' | 'IMAGE_RV' | 'CLC' | 'CLI' | 'MRK' | 'RPOS' | 'POSE_EQUIVALENT' | 'LIDAR_LAS' | 'LIDAR_LAZ' | 'CAMERA_METADATA';
  assetId?: string | null;
  fileName: string;
  sha256: string;
  cameraSerial?: string | null;
  poseIdentity?: string | null;
  timebase?: string | null;
  crs?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface CreatePineStocktakeInput {
  projectId: string;
  teamId: string;
  orthomosaicId?: string;
  createdById: string;
  files: MissionFileInput[];
  latitude: number;
  longitude: number;
  poseTimebase: string;
}

const SHA256 = /^[a-f0-9]{64}$/;

export function stableSha256(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    return input;
  };
  return createHash('sha256').update(JSON.stringify(normalize(value))).digest('hex');
}

export function validateMissionFiles(files: readonly MissionFileInput[], poseTimebase: string): { imageCount: number; targetCrs: string } {
  const kinds = new Set(files.map((file) => file.kind));
  const required = ['IMAGE_LV', 'IMAGE_RV', 'CLC', 'CLI', 'MRK'] as const;
  for (const kind of required) if (!kinds.has(kind)) throw new Error(`missing mission file: ${kind}`);
  if (!kinds.has('RPOS') && !kinds.has('POSE_EQUIVALENT')) throw new Error('missing pose identity: RPOS or equivalent is required');
  if (!kinds.has('LIDAR_LAS') && !kinds.has('LIDAR_LAZ')) throw new Error('missing LiDAR LAS/LAZ');
  if (!poseTimebase.trim()) throw new Error('ambiguous timebase');
  if (files.some((file) => !SHA256.test(file.sha256))) throw new Error('every mission file requires a SHA-256 hash');
  if (files.filter((file) => file.kind !== 'CAMERA_METADATA').some((file) => !file.assetId)) throw new Error('every required raw mission file must be associated with a project asset');
  const images = files.filter((file) => file.kind === 'IMAGE_LV' || file.kind === 'IMAGE_RV');
  if (images.some((image) => !image.cameraSerial)) throw new Error('camera serial is missing from one or more images');
  const poseFiles = files.filter((file) => file.kind === 'MRK' || file.kind === 'RPOS' || file.kind === 'POSE_EQUIVALENT');
  if (poseFiles.some((file) => file.timebase !== poseTimebase)) throw new Error('pose timebase cannot be proven');
  if (poseFiles.some((file) => !file.poseIdentity)) throw new Error('pose identity cannot be proven');
  const clc = files.find((file) => file.kind === 'CLC');
  const calibrationSerials = Array.isArray(clc?.metadata?.cameraSerials)
    ? clc.metadata.cameraSerials.filter((serial): serial is string => typeof serial === 'string')
    : [];
  if (!calibrationSerials.length) throw new Error('CLC camera serial identity is missing');
  const imageSerials = images.map((image) => image.cameraSerial as string);
  const missingSerial = imageSerials.find((serial) => !calibrationSerials.includes(serial));
  if (missingSerial) throw new Error(`camera serial mismatch: ${missingSerial}`);
  const cli = files.find((file) => file.kind === 'CLI');
  if (!Array.isArray(cli?.metadata?.quaternion) || !Array.isArray(cli?.metadata?.translation)) throw new Error('CLI transform identity is missing');
  const crsValues = [...new Set(files.flatMap((file) => file.crs ? [file.crs] : []))];
  if (crsValues.length !== 1) throw new Error(crsValues.length ? 'conflicting CRS identities' : 'unknown CRS');
  return { imageCount: images.length, targetCrs: crsValues[0] };
}

export function validateCalibrationContent(params: { clcText: string; cliText: string; imageSerials: string[] }): void {
  const cameras = parseClc(params.clcText);
  parseCli(params.cliText);
  validateCameraSerials(params.imageSerials, cameras);
}

export function buildImmutableManifest(input: CreatePineStocktakeInput) {
  const selectedCrs = selectProjectedCrs(input.latitude, input.longitude);
  const declaredCrs = [...new Set(input.files.flatMap((file) => file.crs ? [file.crs] : []))];
  if (declaredCrs.length !== 1 || declaredCrs[0] !== selectedCrs) throw new Error(`CRS mismatch: expected ${selectedCrs}`);
  validateMissionFiles(input.files, input.poseTimebase);
  const manifest = {
    schema: 'nd.agri.pine-stocktake.manifest.v1',
    method: PINE_STOCKTAKE_METHOD,
    model: SAM3_IDENTITY,
    config: PINE_STOCKTAKE_CONFIG,
    runner: FLAT_MAP_RUNNER_IDENTITY,
    projectId: input.projectId,
    orthomosaicId: input.orthomosaicId ?? null,
    targetCrs: selectedCrs,
    poseTimebase: input.poseTimebase,
    files: [...input.files].sort((a, b) => a.kind.localeCompare(b.kind) || a.fileName.localeCompare(b.fileName)),
  };
  return { manifest, sha256: stableSha256(manifest), targetCrs: selectedCrs };
}

export async function createPineStocktake(input: CreatePineStocktakeInput) {
  assertPinnedModel(SAM3_IDENTITY);
  const { manifest, sha256, targetCrs } = buildImmutableManifest(input);
  return prisma.pineStocktakeJob.create({
    data: {
      projectId: input.projectId,
      teamId: input.teamId,
      orthomosaicId: input.orthomosaicId,
      createdById: input.createdById,
      methodVersion: PINE_STOCKTAKE_METHOD,
      modelRepository: SAM3_IDENTITY.repository,
      modelRevision: SAM3_IDENTITY.revision,
      modelWeightSha256: SAM3_IDENTITY.weightSha256,
      modelConfig: PINE_STOCKTAKE_CONFIG as unknown as Prisma.InputJsonValue,
      immutableManifest: manifest as unknown as Prisma.InputJsonValue,
      immutableManifestSha256: sha256,
      runnerPath: FLAT_MAP_RUNNER_IDENTITY.path,
      runnerCommit: FLAT_MAP_RUNNER_IDENTITY.validatedCommit,
      runnerTreeSha256: FLAT_MAP_RUNNER_IDENTITY.treeSha256,
      targetCrs,
      poseTimebase: input.poseTimebase,
      status: 'QUEUED',
      missionFiles: {
        create: input.files.map((file) => ({
          kind: file.kind,
          assetId: file.assetId,
          fileName: file.fileName,
          sha256: file.sha256,
          cameraSerial: file.cameraSerial,
          poseIdentity: file.poseIdentity,
          timebase: file.timebase,
          crs: file.crs,
          metadata: file.metadata as Prisma.InputJsonValue | undefined,
        })),
      },
    },
  });
}

function requiredEndpoint(name: 'PINE_STOCKTAKE_SAM3_URL' | 'PINE_FLAT_MAP_RUNNER_URL' | 'PINE_STOCKTAKE_LIDAR_URL'): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured; no fallback backend is permitted`);
  return value.replace(/\/+$/, '');
}

async function assertBackendIdentity(baseUrl: string, expected: Record<string, string>): Promise<void> {
  const response = await fetch(`${baseUrl}/identity`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`backend identity check failed: HTTP ${response.status}`);
  const actual = await response.json() as Record<string, string>;
  for (const [key, value] of Object.entries(expected)) if (actual[key] !== value) throw new Error(`backend identity mismatch for ${key}`);
}

type SamRunResult = {
  idempotencyKey: string; exemplarId: string; targetAssetId: string;
  nativeTileManifest: unknown; candidateIds: string[];
};
type SamCandidateResult = {
  candidateId: string; inferenceRunKey: string; exemplarId: string; targetAssetId: string; targetImageSha256: string;
  score: number; nativeTile: unknown; nativeBbox: unknown; nativePolygon: unknown; maskEncoding: unknown;
  modelResultSha256: string; duplicateLineage: string[];
};
type SamAgreementResult = {
  agreementId: string; targetAssetId: string; representativeCandidateId: string; agreementLevel: number;
  scoresByExemplar: Record<string, number>; nativePolygon: unknown; candidateIds: string[];
};
type SamStageResult = { schema: string; processed: number; inferenceRuns: SamRunResult[]; candidates: SamCandidateResult[]; agreementGroups: SamAgreementResult[] };

async function assetDownloadUrl(asset: PineJobRecord['missionFiles'][number]['asset'] | PineJobRecord['exemplars'][number]['sourceAsset']): Promise<string> {
  if (!asset) throw new Error('image asset is missing');
  if (asset.storageType === 's3' && asset.s3Key) return S3Service.getSignedUrl(asset.s3Key, 3600, asset.s3Bucket ?? undefined);
  if (!asset.storageUrl) throw new Error(`asset ${asset.id} has no readable URL`);
  return asset.storageUrl;
}

function assertSamResult(value: unknown): asserts value is SamStageResult {
  const result = value as Partial<SamStageResult> | null;
  if (!result || result.schema !== 'nd.agri.pine-stocktake.sam3-result.v1' || !Array.isArray(result.inferenceRuns) || !Array.isArray(result.candidates) || !Array.isArray(result.agreementGroups)) throw new Error('SAM3 backend returned an invalid pine-stocktake-v1 result');
}

async function runSam3Stage(job: PineStocktakeJobData, record: PineJobRecord): Promise<PineStocktakeJobResult> {
  const baseUrl = requiredEndpoint('PINE_STOCKTAKE_SAM3_URL');
  await assertBackendIdentity(baseUrl, SAM3_IDENTITY);
  const imageFiles = record.missionFiles.filter((file) => file.kind === 'IMAGE_LV' || file.kind === 'IMAGE_RV');
  const targets = await Promise.all(imageFiles.map(async (file) => {
    if (!file.asset) throw new Error(`target image ${file.fileName} is not associated with an asset`);
    return { assetId: file.asset.id, imageUrl: await assetDownloadUrl(file.asset), sha256: file.sha256 };
  }));
  const exemplars = await Promise.all(record.exemplars.filter((item) => item.approved).map(async (item) => ({
    id: item.id, sourceAssetId: item.sourceAssetId, sourceImageUrl: await assetDownloadUrl(item.sourceAsset),
    sourceImageSha256: item.sourceImageSha256, exemplarSha256: item.exemplarSha256,
    nativePolygon: item.nativePolygon, approved: item.approved,
  })));
  const response = await fetch(`${baseUrl}/jobs`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(6 * 60 * 60 * 1000),
    body: JSON.stringify({ stocktakeJobId: record.id, stage: job.stage, idempotencyKey: job.idempotencyKey, immutableManifestSha256: record.immutableManifestSha256, targets, exemplars }),
  });
  if (!response.ok) throw new Error(`detect_exemplars failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result: unknown = await response.json();
  assertSamResult(result);
  if (result.candidates.some((candidate) => candidate.score < PINE_STOCKTAKE_CONFIG.scoreThreshold)) throw new Error('SAM3 backend returned a candidate below the pinned score threshold');
  await prisma.$transaction(async (tx) => {
    const existingCandidates = await tx.pineCandidate.findMany({ where: { jobId: record.id, candidateId: { in: result.candidates.map((item) => item.candidateId) } }, select: { candidateId: true, modelResultSha256: true } });
    for (const existing of existingCandidates) {
      const incoming = result.candidates.find((item) => item.candidateId === existing.candidateId);
      if (!incoming || incoming.modelResultSha256 !== existing.modelResultSha256) throw new Error(`immutable candidate drift: ${existing.candidateId}`);
    }
    const runIds = new Map<string, string>();
    for (const run of result.inferenceRuns) {
      const modelResult = { candidateIds: run.candidateIds };
      const saved = await tx.pineInferenceRun.upsert({
        where: { idempotencyKey: run.idempotencyKey },
        create: { jobId: record.id, exemplarId: run.exemplarId, targetAssetId: run.targetAssetId, idempotencyKey: run.idempotencyKey, status: 'completed', nativeTileManifest: run.nativeTileManifest as Prisma.InputJsonValue, modelResult: modelResult as Prisma.InputJsonValue, modelResultSha256: stableSha256(modelResult), attemptCount: 1, startedAt: new Date(), completedAt: new Date() },
        update: { status: 'completed', completedAt: new Date() },
      });
      runIds.set(run.idempotencyKey, saved.id);
    }
    await tx.pineCandidate.createMany({ data: result.candidates.filter((item) => !existingCandidates.some((existing) => existing.candidateId === item.candidateId)).map((item) => {
      const inferenceRunId = runIds.get(item.inferenceRunKey);
      if (!inferenceRunId) throw new Error(`candidate ${item.candidateId} has no inference run`);
      return { candidateId: item.candidateId, jobId: record.id, inferenceRunId, targetAssetId: item.targetAssetId, targetImageSha256: item.targetImageSha256, exemplarId: item.exemplarId, nativeTile: item.nativeTile as Prisma.InputJsonValue, nativePolygon: item.nativePolygon as Prisma.InputJsonValue, nativeBbox: item.nativeBbox as Prisma.InputJsonValue, maskEncoding: item.maskEncoding as Prisma.InputJsonValue, score: item.score, modelResultSha256: item.modelResultSha256, duplicateLineage: item.duplicateLineage as Prisma.InputJsonValue };
    }), skipDuplicates: true });
    const stored = await tx.pineCandidate.findMany({ where: { jobId: record.id }, select: { id: true, candidateId: true } });
    const storedByCandidateId = new Map(stored.map((item) => [item.candidateId, item.id]));
    for (const group of result.agreementGroups) {
      const existing = await tx.pineAgreementGroup.findUnique({ where: { jobId_agreementId: { jobId: record.id, agreementId: group.agreementId } }, select: { id: true, scoresByExemplar: true, nativePolygon: true } });
      if (existing) {
        if (stableSha256({ scores: existing.scoresByExemplar, polygon: existing.nativePolygon }) !== stableSha256({ scores: group.scoresByExemplar, polygon: group.nativePolygon })) throw new Error(`immutable agreement drift: ${group.agreementId}`);
        continue;
      }
      const memberIds = group.candidateIds.map((candidateId) => storedByCandidateId.get(candidateId));
      if (memberIds.some((id) => !id)) throw new Error(`agreement ${group.agreementId} references an unknown candidate`);
      await tx.pineAgreementGroup.create({ data: { jobId: record.id, agreementId: group.agreementId, targetAssetId: group.targetAssetId, representativeCandidateId: group.representativeCandidateId, agreementLevel: group.agreementLevel, scoresByExemplar: group.scoresByExemplar as Prisma.InputJsonValue, nativePolygon: group.nativePolygon as Prisma.InputJsonValue, members: { create: memberIds.map((candidateId) => ({ candidateId: candidateId! })) } } });
    }
  });
  return { stocktakeJobId: record.id, stage: job.stage, status: 'review_required', processed: result.processed };
}

type FlatMapArtifact = { url: string; sha256: string };
type FlatMapStageResult = {
  schema: 'nd.agri.pine-stocktake.flat-map-result.v1'; runnerCommit: string; runnerTreeSha256: string;
  inputManifestSha256: string; projectedCrs: string; status: 'completed'; previewBounds: [number, number, number, number];
  outputs: { geotiff: FlatMapArtifact; previewPng: FlatMapArtifact; footprintsGeojson: FlatMapArtifact; imageMetadataCsv: FlatMapArtifact; inputManifest: FlatMapArtifact; runSummary: FlatMapArtifact; browserViewer: FlatMapArtifact };
};

function isArtifact(value: unknown): value is FlatMapArtifact {
  const artifact = value as Partial<FlatMapArtifact> | null;
  return Boolean(artifact && typeof artifact.url === 'string' && SHA256.test(artifact.sha256 ?? ''));
}

async function runFlatMapStage(job: PineStocktakeJobData, record: PineJobRecord): Promise<PineStocktakeJobResult> {
  const baseUrl = requiredEndpoint('PINE_FLAT_MAP_RUNNER_URL');
  await assertBackendIdentity(baseUrl, { commit: FLAT_MAP_RUNNER_IDENTITY.validatedCommit, treeSha256: FLAT_MAP_RUNNER_IDENTITY.treeSha256 });
  const imageFiles = record.missionFiles.filter((file) => file.kind === 'IMAGE_LV' || file.kind === 'IMAGE_RV');
  const images = await Promise.all(imageFiles.map(async (file) => {
    if (!file.asset) throw new Error(`Flat Map image ${file.fileName} is not associated with an asset`);
    return { assetId: file.asset.id, fileName: file.fileName, sha256: file.sha256, imageUrl: await assetDownloadUrl(file.asset) };
  }));
  const input = { stocktakeJobId: record.id, stage: job.stage, idempotencyKey: job.idempotencyKey, immutableManifestSha256: record.immutableManifestSha256, projectedCrs: record.targetCrs, images, acceptedCrowns: record.acceptedCrowns.map((crown) => ({ crownId: crown.crownId, sourceAssetId: crown.sourceAssetId, sourceImageSha256: crown.sourceImageSha256, nativePolygon: crown.nativePolygon })) };
  const inputManifestSha256 = stableSha256(input);
  const response = await fetch(`${baseUrl}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(6 * 60 * 60 * 1000), body: JSON.stringify({ ...input, inputManifestSha256 }) });
  if (!response.ok) throw new Error(`build_flat_map failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result = await response.json() as Partial<FlatMapStageResult>;
  const artifacts = result.outputs ? Object.values(result.outputs) : [];
  const bounds = result.previewBounds;
  if (result.schema !== 'nd.agri.pine-stocktake.flat-map-result.v1' || result.runnerCommit !== FLAT_MAP_RUNNER_IDENTITY.validatedCommit || result.runnerTreeSha256 !== FLAT_MAP_RUNNER_IDENTITY.treeSha256 || result.inputManifestSha256 !== inputManifestSha256 || result.projectedCrs !== record.targetCrs || result.status !== 'completed' || artifacts.length !== 7 || !artifacts.every(isArtifact) || !Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite) || bounds[0] >= bounds[2] || bounds[1] >= bounds[3]) throw new Error('Flat Map result identity or artifact hash validation failed');
  const outputs = result.outputs!;
  const existing = await prisma.pineFlatMapResult.findUnique({ where: { jobId: record.id } });
  if (existing && (existing.inputManifestSha256 !== inputManifestSha256 || existing.runnerTreeSha256 !== result.runnerTreeSha256)) throw new Error('immutable Flat Map result drift');
  await prisma.pineFlatMapResult.upsert({ where: { jobId: record.id }, create: {
    jobId: record.id, runnerCommit: result.runnerCommit!, runnerTreeSha256: result.runnerTreeSha256!, inputManifestSha256,
    projectedCrs: result.projectedCrs!, approximate: true, geotiffSha256: outputs.geotiff.sha256,
    previewPngSha256: outputs.previewPng.sha256, footprintsSha256: outputs.footprintsGeojson.sha256,
    metadataCsvSha256: outputs.imageMetadataCsv.sha256, runSummarySha256: outputs.runSummary.sha256,
    outputs: { ...outputs, previewBounds: bounds } as unknown as Prisma.InputJsonValue, status: 'completed', completedAt: new Date(),
  }, update: { status: 'completed', completedAt: new Date() } });
  return { stocktakeJobId: record.id, stage: job.stage, status: 'completed', processed: images.length };
}

type LidarAssociationResult = {
  crownId: string; status: 'matched' | 'missing'; method: string; x: number | null; y: number | null;
  apexX: number | null; apexY: number | null; apexZ: number | null; heightP99M: number | null;
  heightMaxValidM: number | null; localGroundZ: number | null; matchConfidence: number | null;
  vegetationPointIds: string[]; observationLineage: string[]; missingReason: string | null; failureDetail: string | null;
};
type LidarDuplicateResult = { duplicateGroupId: string; crownIds: string[]; observationLineage: string[]; canonicalCrownId: string; status: string };
type LidarStageResult = { schema: 'nd.agri.pine-stocktake.lidar-result.v1'; inputManifestSha256: string; projectedCrs: string; associations: LidarAssociationResult[]; duplicateGroups: LidarDuplicateResult[] };

async function runLidarStage(job: PineStocktakeJobData, record: PineJobRecord): Promise<PineStocktakeJobResult> {
  const baseUrl = requiredEndpoint('PINE_STOCKTAKE_LIDAR_URL');
  await assertBackendIdentity(baseUrl, { method: 'image-clc-cli-pose-lidar-v1' });
  const missionFiles = await Promise.all(record.missionFiles.map(async (file) => {
    if (!file.asset) throw new Error(`precise mapping input ${file.fileName} is not associated with an asset`);
    return { kind: file.kind, fileName: file.fileName, sha256: file.sha256, cameraSerial: file.cameraSerial, poseIdentity: file.poseIdentity, timebase: file.timebase, crs: file.crs, url: await assetDownloadUrl(file.asset) };
  }));
  const input = {
    stocktakeJobId: record.id, stage: job.stage, idempotencyKey: job.idempotencyKey,
    immutableManifestSha256: record.immutableManifestSha256, projectedCrs: record.targetCrs,
    poseTimebase: record.poseTimebase, missionFiles,
    acceptedCrowns: record.acceptedCrowns.map((crown) => ({ crownId: crown.crownId, sourceAssetId: crown.sourceAssetId, sourceImageSha256: crown.sourceImageSha256, nativePolygon: crown.nativePolygon, contributingExemplarIds: crown.contributingExemplarIds, revisionLineage: crown.revisionLineage, edgeClipped: crown.edgeClipped })),
    recovery: { rayMinHagM: 0.15, rayMaxHagM: 2.30, vegetationClasses: [3, 4, 5], rayNeighbourhoodRadiusM: 0.75, duplicateRadiusM: 0.50 },
  };
  const inputManifestSha256 = stableSha256(input);
  const response = await fetch(`${baseUrl}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(6 * 60 * 60 * 1000), body: JSON.stringify({ ...input, inputManifestSha256 }) });
  if (!response.ok) throw new Error(`map_lidar failed: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  const result = await response.json() as Partial<LidarStageResult>;
  if (result.schema !== 'nd.agri.pine-stocktake.lidar-result.v1' || result.inputManifestSha256 !== inputManifestSha256 || result.projectedCrs !== record.targetCrs || !Array.isArray(result.associations) || !Array.isArray(result.duplicateGroups)) throw new Error('calibrated LiDAR result identity validation failed');
  const crownByStableId = new Map(record.acceptedCrowns.map((crown) => [crown.crownId, crown]));
  if (result.associations.length !== record.acceptedCrowns.length || result.associations.some((item) => !crownByStableId.has(item.crownId))) throw new Error('every accepted crown must have one LiDAR result');
  for (const item of result.associations) {
    const matched = item.status === 'matched';
    if (matched && (![item.x, item.y, item.apexX, item.apexY, item.apexZ, item.heightP99M, item.heightMaxValidM, item.localGroundZ, item.matchConfidence].every((value) => typeof value === 'number' && Number.isFinite(value)) || item.missingReason)) throw new Error(`matched crown ${item.crownId} has incomplete LiDAR evidence`);
    if (!matched && (!item.missingReason || [item.x, item.y, item.apexX, item.apexY, item.apexZ, item.heightP99M].some((value) => value != null))) throw new Error(`missing crown ${item.crownId} must have a reason and no invented coordinate`);
  }
  await prisma.$transaction(async (tx) => {
    for (const item of result.associations!) {
      const crown = crownByStableId.get(item.crownId)!;
      const incomingFingerprint = stableSha256(item);
      const existing = await tx.pineLidarAssociation.findUnique({ where: { acceptedCrownId: crown.id } });
      const existingFingerprint = existing ? stableSha256({ crownId: item.crownId, status: existing.status, method: existing.method, x: existing.x, y: existing.y, apexX: existing.apexX, apexY: existing.apexY, apexZ: existing.apexZ, heightP99M: existing.heightP99M, heightMaxValidM: existing.heightMaxValidM, localGroundZ: existing.localGroundZ, matchConfidence: existing.matchConfidence, vegetationPointIds: existing.vegetationPointIds ?? [], observationLineage: existing.observationLineage, missingReason: existing.missingReason, failureDetail: existing.failureDetail }) : null;
      if (existing && existingFingerprint !== incomingFingerprint) throw new Error(`immutable LiDAR association drift: ${item.crownId}`);
      if (!existing) await tx.pineLidarAssociation.create({ data: {
        acceptedCrownId: crown.id, status: item.status, method: item.method, x: item.x, y: item.y,
        apexX: item.apexX, apexY: item.apexY, apexZ: item.apexZ, heightP99M: item.heightP99M,
        heightMaxValidM: item.heightMaxValidM, localGroundZ: item.localGroundZ, matchConfidence: item.matchConfidence,
        vegetationPointIds: item.vegetationPointIds as Prisma.InputJsonValue, observationLineage: item.observationLineage as Prisma.InputJsonValue,
        missingReason: item.missingReason, failureDetail: item.failureDetail,
      } });
    }
    for (const group of result.duplicateGroups!) {
      if (!group.crownIds.length || !group.crownIds.includes(group.canonicalCrownId) || group.crownIds.some((crownId) => !crownByStableId.has(crownId))) throw new Error(`invalid duplicate group ${group.duplicateGroupId}`);
      await tx.pineDuplicateGroup.upsert({ where: { jobId_duplicateGroupId: { jobId: record.id, duplicateGroupId: group.duplicateGroupId } }, create: { jobId: record.id, duplicateGroupId: group.duplicateGroupId, acceptedCrownIds: group.crownIds as Prisma.InputJsonValue, observationLineage: group.observationLineage as Prisma.InputJsonValue, canonicalCrownId: group.canonicalCrownId, status: group.status }, update: {} });
    }
  });
  return { stocktakeJobId: record.id, stage: job.stage, status: 'completed', processed: result.associations.length };
}

export async function processPineStocktakeStage(job: PineStocktakeJobData): Promise<PineStocktakeJobResult> {
  const record = await prisma.pineStocktakeJob.findUnique({
    where: { id: job.stocktakeJobId },
    include: pineJobInclude,
  });
  if (!record) throw new Error('pine stocktake job not found');
  assertPinnedModel({ repository: record.modelRepository, revision: record.modelRevision, weightSha256: record.modelWeightSha256 });
  const restart = (record.restartState ?? {}) as Record<string, unknown>;
  if (restart[job.stage] === job.idempotencyKey) return { stocktakeJobId: record.id, stage: job.stage, status: job.stage === 'detect_exemplars' ? 'review_required' : 'completed', processed: 0 };
  await prisma.pineStocktakeJob.update({ where: { id: record.id }, data: { status: 'PROCESSING', startedAt: record.startedAt ?? new Date(), failureReason: null } });
  try {
    let result: PineStocktakeJobResult;
    if (job.stage === 'validate_mission') {
      const files = record.missionFiles.map((file) => ({ ...file, metadata: (file.metadata ?? undefined) as Record<string, unknown> | undefined }));
      validateMissionFiles(files, record.poseTimebase ?? '');
      result = { stocktakeJobId: record.id, stage: job.stage, status: 'completed', processed: files.length };
    } else if (job.stage === 'detect_exemplars') {
      if (record.exemplars.filter((item) => item.approved).length !== 3) throw new Error('exactly three approved external exemplars are required');
      const approved = record.exemplars.filter((item) => item.approved).map((item) => ({ id: item.id, sourceImageId: item.sourceAssetId, sourceImageSha256: item.sourceImageSha256, polygon: item.nativePolygon as unknown as readonly (readonly [number, number])[], approved: item.approved }));
      for (const target of record.missionFiles.filter((file) => file.kind === 'IMAGE_LV' || file.kind === 'IMAGE_RV')) {
        if (!target.assetId) throw new Error(`target image ${target.fileName} has no asset identity`);
        assertThreeExternalExemplars(approved, target.assetId);
      }
      result = await runSam3Stage(job, record);
    } else if (job.stage === 'build_flat_map') {
      if (!record.acceptedCrowns.length) throw new Error('only accepted crowns can enter Flat Map processing');
      result = await runFlatMapStage(job, record);
    } else if (job.stage === 'map_lidar') {
      if (!record.acceptedCrowns.length) throw new Error('only accepted crowns can enter mapping or export');
      result = await runLidarStage(job, record);
    } else {
      if (!record.acceptedCrowns.length) throw new Error('only accepted crowns can enter mapping or export');
      const associations = await prisma.pineLidarAssociation.count({ where: { acceptedCrown: { jobId: record.id } } });
      if (associations !== record.acceptedCrowns.length) throw new Error('every accepted crown requires a LiDAR result or explicit missing reason before export');
      result = { stocktakeJobId: record.id, stage: job.stage, status: 'completed', processed: record.acceptedCrowns.length };
    }
    const stageState = job.stage === 'validate_mission'
      ? { stage: 'EXEMPLARS_DETECT' as const, progress: 20, status: 'PROCESSING' as const, completedAt: null }
      : job.stage === 'detect_exemplars'
        ? { stage: 'REVIEW_CROWNS' as const, progress: 55, status: 'REVIEW_REQUIRED' as const, completedAt: null }
        : job.stage === 'build_flat_map'
          ? { stage: 'MAP_HEIGHT_EXPORT' as const, progress: 75, status: 'PROCESSING' as const, completedAt: null }
          : job.stage === 'map_lidar'
            ? { stage: 'MAP_HEIGHT_EXPORT' as const, progress: 90, status: 'PROCESSING' as const, completedAt: null }
            : { stage: 'MAP_HEIGHT_EXPORT' as const, progress: 100, status: 'COMPLETED' as const, completedAt: new Date() };
    await prisma.pineStocktakeJob.update({
      where: { id: record.id },
      data: {
        restartState: { ...restart, [job.stage]: job.idempotencyKey } as Prisma.InputJsonValue,
        ...stageState,
      },
    });
    return result;
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'unknown Pine Stocktake failure';
    await prisma.pineStocktakeJob.update({ where: { id: record.id }, data: { status: 'BLOCKED', failureReason } });
    throw error;
  }
}
