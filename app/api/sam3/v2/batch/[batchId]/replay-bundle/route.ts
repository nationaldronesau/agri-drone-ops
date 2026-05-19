import JSZip from 'jszip';
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { S3Service } from '@/lib/services/s3';
import { scaleExemplarBoxes, type BoxCoordinate } from '@/lib/utils/exemplar-scaling';
import { SAM3_BATCH_JOB_KINDS } from '@/lib/utils/sam3-batch-jobs';

interface RouteParams {
  params: Promise<{ batchId: string }>;
}

const BATCH_ID_REGEX = /^c[a-z0-9]{24,}$/i;
const DEFAULT_TARGET_LIMIT = 12;
const MAX_TARGET_LIMIT = 50;
const SIGNED_URL_EXPIRY_SECONDS = 24 * 60 * 60;

type ReplayAsset = {
  id: string;
  fileName: string;
  image: string;
  storageType: string;
  width: number | null;
  height: number | null;
};

type AssetForReplay = {
  id: string;
  fileName: string;
  storageUrl: string;
  storageType: string;
  s3Key: string | null;
  s3Bucket: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
};

function isDefined<T>(value: T | null | undefined): value is T {
  return value != null;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function toBoxArray(value: unknown): BoxCoordinate[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const x1 = Number(record.x1);
      const y1 = Number(record.y1);
      const x2 = Number(record.x2);
      const y2 = Number(record.y2);
      if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
      if (x2 === x1 || y2 === y1) return null;
      return {
        x1: Math.min(x1, x2),
        y1: Math.min(y1, y2),
        x2: Math.max(x1, x2),
        y2: Math.max(y1, y2),
      };
    })
    .filter((box): box is BoxCoordinate => Boolean(box));
}

function parseTargetLimit(request: NextRequest): number {
  const rawLimit = Number.parseInt(request.nextUrl.searchParams.get('targetLimit') || '', 10);
  if (!Number.isFinite(rawLimit)) return DEFAULT_TARGET_LIMIT;
  return Math.min(Math.max(rawLimit, 1), MAX_TARGET_LIMIT);
}

function absoluteUrl(request: NextRequest, storageUrl: string): string {
  if (/^https?:\/\//i.test(storageUrl)) {
    return storageUrl;
  }
  return new URL(storageUrl, request.url).toString();
}

async function resolveAssetImageUrl(
  request: NextRequest,
  asset: {
    storageType: string;
    storageUrl: string;
    s3Key: string | null;
    s3Bucket: string | null;
  }
): Promise<string> {
  if (asset.storageType.toLowerCase() === 's3' && asset.s3Key) {
    return S3Service.getSignedUrl(
      asset.s3Key,
      SIGNED_URL_EXPIRY_SECONDS,
      asset.s3Bucket || undefined
    );
  }

  return absoluteUrl(request, asset.storageUrl);
}

function uniqueAssetIds(ids: string[]): string[] {
  return Array.from(new Set(ids));
}

function toSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sam3-replay';
}

export async function GET(
  request: NextRequest,
  { params }: RouteParams
): Promise<NextResponse> {
  const { batchId } = await params;
  const targetLimit = parseTargetLimit(request);

  if (!BATCH_ID_REGEX.test(batchId)) {
    return NextResponse.json(
      { success: false, error: 'Invalid batch job ID format' },
      { status: 400 }
    );
  }

  const batchJob = await prisma.batchJob.findUnique({
    where: { id: batchId },
    include: {
      project: {
        select: {
          id: true,
          name: true,
        },
      },
      childBatchJobs: {
        orderBy: [
          { shardIndex: 'asc' },
          { createdAt: 'asc' },
        ],
        select: {
          id: true,
          assetIds: true,
        },
      },
    },
  });

  if (!batchJob) {
    return NextResponse.json(
      { success: false, error: 'Batch job not found' },
      { status: 404 }
    );
  }

  const projectAccess = await checkProjectAccess(batchJob.projectId);
  if (!projectAccess.authenticated) {
    return NextResponse.json(
      { success: false, error: 'Authentication required' },
      { status: 401 }
    );
  }
  if (!projectAccess.hasAccess) {
    return NextResponse.json(
      { success: false, error: projectAccess.error || 'Access denied' },
      { status: 403 }
    );
  }

  const rawExemplars = toBoxArray(batchJob.exemplars);
  if (rawExemplars.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Batch job does not contain replayable source boxes' },
      { status: 400 }
    );
  }

  const childAssetIds = batchJob.childBatchJobs.flatMap((childJob) =>
    toStringArray(childJob.assetIds)
  );
  const directAssetIds = toStringArray(batchJob.assetIds);
  const batchAssetIds = uniqueAssetIds(directAssetIds.length > 0 ? directAssetIds : childAssetIds);

  const sourceAssetId = batchJob.sourceAssetId || batchAssetIds[0];
  if (!sourceAssetId) {
    return NextResponse.json(
      { success: false, error: 'Batch job does not contain a source asset' },
      { status: 400 }
    );
  }

  const targetAssetIds = batchAssetIds.filter((assetId) => assetId !== sourceAssetId);
  const replayAssetIds = uniqueAssetIds([
    sourceAssetId,
    ...targetAssetIds.slice(0, targetLimit),
  ]);

  const assets: AssetForReplay[] = await prisma.asset.findMany({
    where: {
      id: { in: replayAssetIds },
      projectId: batchJob.projectId,
    },
    select: {
      id: true,
      fileName: true,
      storageUrl: true,
      storageType: true,
      s3Key: true,
      s3Bucket: true,
      imageWidth: true,
      imageHeight: true,
    },
  });
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const sourceAsset = assetById.get(sourceAssetId);

  if (!sourceAsset) {
    return NextResponse.json(
      { success: false, error: 'Source asset could not be found' },
      { status: 400 }
    );
  }

  const sourceBoxes = scaleExemplarBoxes({
    exemplars: rawExemplars,
    sourceWidth: batchJob.exemplarSourceWidth || undefined,
    sourceHeight: batchJob.exemplarSourceHeight || undefined,
    targetWidth: sourceAsset.imageWidth || batchJob.exemplarSourceWidth || 0,
    targetHeight: sourceAsset.imageHeight || batchJob.exemplarSourceHeight || 0,
    maxBoxes: rawExemplars.length,
    jobId: batchJob.id,
    assetId: sourceAsset.id,
  });

  if (sourceBoxes.boxes.length === 0) {
    return NextResponse.json(
      { success: false, error: 'Source boxes could not be scaled for replay' },
      { status: 400 }
    );
  }

  const orderedTargetAssets = targetAssetIds
    .slice(0, targetLimit)
    .map((assetId) => assetById.get(assetId))
    .filter(isDefined);

  const [sourceReplayAsset, targetReplayAssets] = await Promise.all([
    toReplayAsset(request, sourceAsset),
    Promise.all(orderedTargetAssets.map((asset) => toReplayAsset(request, asset))),
  ]);

  const fixture = {
    name: `ag3-${batchJob.id}`,
    className: batchJob.textPrompt || batchJob.weedType,
    source: {
      id: sourceReplayAsset.id,
      image: sourceReplayAsset.image,
      boxes: sourceBoxes.boxes,
    },
    targets: targetReplayAssets.map((asset) => ({
      id: asset.id,
      image: asset.image,
    })),
  };

  const manifest = {
    createdAt: new Date().toISOString(),
    batchJob: {
      id: batchJob.id,
      parentBatchJobId: batchJob.parentBatchJobId,
      projectId: batchJob.projectId,
      projectName: batchJob.project.name,
      weedType: batchJob.weedType,
      textPrompt: batchJob.textPrompt,
      kind: batchJob.kind || SAM3_BATCH_JOB_KINDS.SINGLE,
      mode: batchJob.mode,
      status: batchJob.status,
      totalImages: batchJob.totalImages,
      processedImages: batchJob.processedImages,
      detectionsFound: batchJob.detectionsFound,
      errorMessage: batchJob.errorMessage,
      createdAt: batchJob.createdAt,
      completedAt: batchJob.completedAt,
    },
    replay: {
      targetLimit,
      includedTargetCount: targetReplayAssets.length,
      availableTargetCount: targetAssetIds.length,
      signedUrlExpiresInSeconds: SIGNED_URL_EXPIRY_SECONDS,
      sourceBoxScalingWarnings: sourceBoxes.warnings,
    },
    source: sourceReplayAsset,
    targets: targetReplayAssets,
    allAssetIds: batchAssetIds,
  };

  const readme = [
    '# SAM3 Replay Bundle',
    '',
    'This bundle was exported from the AgriDrone Ops UI so Manas does not need to run scripts or reconstruct image/box coordinates manually.',
    '',
    'Run from the repo root:',
    '',
    '```bash',
    'npm ci',
    `npm run sam3:replay -- --fixture ./fixture.json --sam3-url http://<SAM3_HOST>:8000 --out ./tmp/sam3-replay/${batchJob.id}`,
    '```',
    '',
    'Decision rules:',
    '- Baseline returns zero detections but enhanced finds targets: promote enhanced source crops into production v2.',
    '- Both return zero detections: likely SAM3 model/service behavior or source exemplar quality.',
    '- Replay returns detections but UI shows none: persistence/review display is hiding valid detections.',
    '',
    'Note: image URLs in fixture.json are signed or absolute URLs. Run the replay before the signed URLs expire.',
    '',
  ].join('\n');

  const zip = new JSZip();
  zip.file('fixture.json', JSON.stringify(fixture, null, 2));
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('README.md', readme);

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
  });

  const filename = `${toSlug(batchJob.project.name)}-${batchJob.id}-sam3-replay.zip`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function toReplayAsset(
  request: NextRequest,
  asset: AssetForReplay
): Promise<ReplayAsset> {
  return {
    id: asset.id,
    fileName: asset.fileName,
    image: await resolveAssetImageUrl(request, asset),
    storageType: asset.storageType,
    width: asset.imageWidth,
    height: asset.imageHeight,
  };
}
