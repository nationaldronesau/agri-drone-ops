import fs from 'node:fs/promises';
import path from 'node:path';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';

interface CliOptions {
  candidatesPath: string;
  createReviewSession: boolean;
  dryRun: boolean;
  schemaOnly: boolean;
}

export interface CandidateFile {
  schemaVersion?: string;
  sourceSessionId?: string;
  projectId?: string;
  className?: string;
  generator?: Record<string, unknown>;
  candidates?: CandidateInput[];
}

export interface CandidateInput {
  assetId: string;
  className?: string;
  confidence?: number;
  similarity?: number;
  bbox?: [number, number, number, number];
  polygon?: number[][];
  point?: [number, number];
  boxSize?: number;
  notes?: string;
}

interface NormalizedCandidate {
  assetId: string;
  weedType: string;
  confidence: number;
  similarity: number | null;
  bbox: [number, number, number, number];
  polygon: number[][];
  notes?: string;
}

export interface ImportReviewSessionOwner {
  teamId: string;
  createdById: string;
  yoloModelName?: string | null;
}

export interface ImportDinoCandidatesOptions {
  candidateFile: CandidateFile;
  candidatesPath?: string;
  createReviewSession?: boolean;
  dryRun?: boolean;
  schemaOnly?: boolean;
  reviewSessionOwner?: ImportReviewSessionOwner;
}

export interface ImportDinoCandidatesResult {
  ok: true;
  schemaOnly?: boolean;
  dryRun?: boolean;
  projectId: string | null;
  sourceSessionId: string | null;
  batchJobId?: string;
  reviewSessionId?: string | null;
  reviewUrl?: string | null;
  assets: number;
  candidates: number;
  createReviewSession?: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    createReviewSession: false,
    dryRun: false,
    schemaOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--candidates') {
      options.candidatesPath = requireValue(arg, next);
      index += 1;
    } else if (arg === '--create-review-session') {
      options.createReviewSession = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--schema-only') {
      options.schemaOnly = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.candidatesPath) {
    throw new Error('Provide --candidates <path-to-dino-candidates.json>.');
  }

  return options as CliOptions;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelpAndExit(): never {
  console.log(`
Usage:
  npm run ag3:dino-import -- --candidates /tmp/ag3-dino/candidates/dino-candidates.json --create-review-session
  npm run ag3:dino-import -- --candidates /tmp/ag3-dino/candidates/dino-candidates.json --dry-run
  npm run ag3:dino-import -- --candidates /tmp/ag3-dino/candidates/dino-candidates.json --schema-only

Candidates must use schema ag3-dino-candidates/v1:
{
  "sourceSessionId": "review-session-id",
  "projectId": "project-id",
  "className": "Pine Sapling",
  "candidates": [
    { "assetId": "...", "confidence": 0.52, "similarity": 0.81, "bbox": [x1,y1,x2,y2] }
  ]
}
`);
  process.exit(0);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampConfidence(value: unknown, fallback: number): number {
  if (!isFiniteNumber(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

function normalizeBbox(candidate: CandidateInput): [number, number, number, number] {
  if (Array.isArray(candidate.bbox) && candidate.bbox.length >= 4) {
    const [x1, y1, x2, y2] = candidate.bbox.map(Number);
    if ([x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1) {
      return [x1, y1, x2, y2];
    }
  }

  if (Array.isArray(candidate.point) && candidate.point.length >= 2) {
    const [x, y] = candidate.point.map(Number);
    const boxSize = isFiniteNumber(candidate.boxSize) && candidate.boxSize > 0
      ? candidate.boxSize
      : 48;
    if ([x, y].every(Number.isFinite)) {
      return [
        x - boxSize / 2,
        y - boxSize / 2,
        x + boxSize / 2,
        y + boxSize / 2,
      ];
    }
  }

  throw new Error(`Candidate for asset ${candidate.assetId} must include a valid bbox or point.`);
}

function normalizePolygon(
  polygon: unknown,
  bbox: [number, number, number, number]
): number[][] {
  if (Array.isArray(polygon)) {
    const points = polygon
      .map((point) => {
        if (!Array.isArray(point) || point.length < 2) return null;
        const x = Number(point[0]);
        const y = Number(point[1]);
        return [x, y].every(Number.isFinite) ? [x, y] : null;
      })
      .filter((point): point is number[] => point != null);
    if (points.length >= 3) return points;
  }

  const [x1, y1, x2, y2] = bbox;
  return [
    [x1, y1],
    [x2, y1],
    [x2, y2],
    [x1, y2],
  ];
}

async function loadCandidateFile(filePath: string): Promise<CandidateFile> {
  const raw = await fs.readFile(path.resolve(filePath), 'utf8');
  const parsed = JSON.parse(raw) as CandidateFile;
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
    throw new Error('Candidate file contains no candidates.');
  }
  return parsed;
}

function normalizeCandidates(file: CandidateFile): NormalizedCandidate[] {
  const defaultClass = file.className || 'Pine Sapling';
  return (file.candidates || []).map((candidate, index) => {
    if (!candidate.assetId || typeof candidate.assetId !== 'string') {
      throw new Error(`Candidate ${index + 1} is missing assetId.`);
    }
    const bbox = normalizeBbox(candidate);
    const polygon = normalizePolygon(candidate.polygon, bbox);
    const similarity = isFiniteNumber(candidate.similarity)
      ? Math.max(0, Math.min(1, candidate.similarity))
      : null;

    return {
      assetId: candidate.assetId,
      weedType: candidate.className || defaultClass,
      confidence: clampConfidence(candidate.confidence, similarity ?? 0.5),
      similarity,
      bbox,
      polygon,
      notes: candidate.notes,
    };
  });
}

async function resolveContext(file: CandidateFile) {
  let sourceSession: {
    id: string;
    teamId: string;
    createdById: string;
    projectId: string;
  } | null = null;

  if (file.sourceSessionId) {
    sourceSession = await prisma.reviewSession.findUnique({
      where: { id: file.sourceSessionId },
      select: {
        id: true,
        teamId: true,
        createdById: true,
        projectId: true,
      },
    });
    if (!sourceSession) {
      throw new Error(`Source review session not found: ${file.sourceSessionId}`);
    }
  }

  const projectId = file.projectId || sourceSession?.projectId;
  if (!projectId) {
    throw new Error('Candidate file must include projectId when sourceSessionId is not provided.');
  }

  return { sourceSession, projectId };
}

export async function importDinoCandidates(
  options: ImportDinoCandidatesOptions
): Promise<ImportDinoCandidatesResult> {
  const candidateFile = options.candidateFile;
  const candidates = normalizeCandidates(candidateFile);

  if (options.schemaOnly) {
    return {
      ok: true,
      schemaOnly: true,
      sourceSessionId: candidateFile.sourceSessionId || null,
      projectId: candidateFile.projectId || null,
      candidates: candidates.length,
      assets: Array.from(new Set(candidates.map((candidate) => candidate.assetId))).length,
    };
  }

  const context = await resolveContext(candidateFile);
  const assetIds = Array.from(new Set(candidates.map((candidate) => candidate.assetId)));

  const validAssets = await prisma.asset.findMany({
    where: {
      id: { in: assetIds },
      projectId: context.projectId,
    },
    select: { id: true },
  });
  const validAssetIds = new Set(validAssets.map((asset) => asset.id));
  const missingAssetIds = assetIds.filter((assetId) => !validAssetIds.has(assetId));
  if (missingAssetIds.length > 0) {
    throw new Error(`Candidates reference assets outside project ${context.projectId}: ${missingAssetIds.join(', ')}`);
  }

  if (options.createReviewSession && !context.sourceSession && !options.reviewSessionOwner) {
    throw new Error('--create-review-session requires sourceSessionId or explicit review session owner.');
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      projectId: context.projectId,
      sourceSessionId: context.sourceSession?.id || null,
      assets: assetIds.length,
      candidates: candidates.length,
      createReviewSession: options.createReviewSession,
    };
  }

  const result = await prisma.$transaction(async (tx) => {
    const batchJob = await tx.batchJob.create({
      data: {
        projectId: context.projectId,
        weedType: candidateFile.className || candidates[0]?.weedType || 'Pine Sapling',
        exemplars: [],
        textPrompt: null,
        sourceAssetId: null,
        kind: 'SINGLE',
        mode: 'DINO_CANDIDATE_MINING',
        assetIds,
        stageLog: {
          source: 'DINO_CANDIDATE_MINING',
          sourceSessionId: candidateFile.sourceSessionId || null,
          generator: candidateFile.generator || null,
          importedFrom: options.candidatesPath ? path.resolve(options.candidatesPath) : null,
          importedAt: new Date().toISOString(),
        } as Prisma.InputJsonValue,
        status: 'COMPLETED',
        totalImages: assetIds.length,
        processedImages: assetIds.length,
        detectionsFound: candidates.length,
        completedAt: new Date(),
      },
    });

    await tx.pendingAnnotation.createMany({
      data: candidates.map((candidate) => ({
        batchJobId: batchJob.id,
        assetId: candidate.assetId,
        weedType: candidate.weedType,
        confidence: candidate.confidence,
        similarity: candidate.similarity,
        bbox: candidate.bbox,
        polygon: candidate.polygon,
        status: 'PENDING',
      })),
    });

    let reviewSession: { id: string } | null = null;
    if (options.createReviewSession) {
      const owner = context.sourceSession
        ? {
            teamId: context.sourceSession.teamId,
            createdById: context.sourceSession.createdById,
            yoloModelName: 'DINO candidate mining',
          }
        : options.reviewSessionOwner;
      if (!owner) {
        throw new Error('Review session owner could not be resolved.');
      }
      reviewSession = await tx.reviewSession.create({
        data: {
          teamId: owner.teamId,
          createdById: owner.createdById,
          projectId: context.projectId,
          workflowType: 'batch_review',
          targetType: 'training',
          yoloModelName: owner.yoloModelName || 'DINO candidate mining',
          weedTypeFilter: candidateFile.className || candidates[0]?.weedType || 'Pine Sapling',
          assetIds,
          assetCount: assetIds.length,
          batchJobIds: [batchJob.id],
          inferenceJobIds: [],
          status: 'active',
        },
        select: { id: true },
      });
    }

    return {
      batchJobId: batchJob.id,
      reviewSessionId: reviewSession?.id || null,
    };
  }, {
    // Bulk imports (25k+ rows) over a remote DB blow the 5s default.
    maxWait: 30_000,
    timeout: 600_000,
  });

  return {
    ok: true,
    projectId: context.projectId,
    batchJobId: result.batchJobId,
    reviewSessionId: result.reviewSessionId,
    assets: assetIds.length,
    candidates: candidates.length,
    reviewUrl: result.reviewSessionId ? `/review?sessionId=${result.reviewSessionId}` : null,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const candidateFile = await loadCandidateFile(options.candidatesPath);
  const result = await importDinoCandidates({
    candidateFile,
    candidatesPath: options.candidatesPath,
    createReviewSession: options.createReviewSession,
    dryRun: options.dryRun,
    schemaOnly: options.schemaOnly,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => undefined);
    });
}
