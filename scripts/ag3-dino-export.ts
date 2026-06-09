import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import prisma from '@/lib/db';
import { S3Service } from '@/lib/services/s3';
import { resolveReviewSessionAssetIds } from '@/lib/services/review-session-assets';
import {
  centerBoxToCorner,
  polygonToCenterBox,
  rescaleToOriginalWithMeta,
} from '@/lib/utils/georeferencing';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

const DEFAULT_OUT_ROOT = 'tmp/ag3-dino-candidate-prep';
const DEFAULT_CLASS_NAME = 'Pine Sapling';
const DEFAULT_OVERLAY_WIDTH = 1800;
const PINE_MODEL_ID = 'cmpp43ahk0001n5wgzn77vjrf';
const GLASSHOUSE_PROJECT_ID = 'cmo6ng4fp0001pm2zbo3341te';

interface CliOptions {
  sessionId?: string;
  latestPineRun: boolean;
  outDir?: string;
  limit?: number;
  noImages: boolean;
  sample: boolean;
  overlayWidth: number;
}

interface ExportAsset {
  id: string;
  fileName: string;
  storageUrl: string;
  s3Key?: string | null;
  s3Bucket?: string | null;
  storageType?: string | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
}

interface ExportDetection {
  id: string;
  source: 'yolo_detection' | 'ai_detection' | 'pending_annotation' | 'manual_annotation';
  sourceId: string;
  assetId: string;
  className: string;
  confidence: number;
  similarity?: number | null;
  bbox: [number, number, number, number];
  polygon?: number[][];
  status: 'pending' | 'accepted' | 'rejected';
  metadata?: Record<string, unknown>;
}

interface ExportBundle {
  schemaVersion: 'ag3-dino-candidate-prep/v1';
  createdAt: string;
  sourceSession: {
    id: string;
    projectId: string;
    workflowType: string;
    createdAt: string;
    yoloModelName?: string | null;
    weedTypeFilter?: string | null;
    inferenceJobIds: string[];
    batchJobIds: string[];
  };
  project: {
    id: string;
    name?: string | null;
  };
  output: {
    root: string;
    imagesDir: string;
    overlaysDir: string;
    detectionsPath: string;
    missedTemplatePath: string;
    candidateTemplatePath: string;
  };
  assets: Array<{
    assetId: string;
    fileName: string;
    imagePath: string | null;
    overlayPath: string | null;
    imageWidth?: number | null;
    imageHeight?: number | null;
    detectionCount: number;
  }>;
  totals: {
    assets: number;
    detections: number;
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    latestPineRun: false,
    noImages: false,
    sample: false,
    overlayWidth: DEFAULT_OVERLAY_WIDTH,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--sessionId') {
      options.sessionId = requireValue(arg, next);
      index += 1;
    } else if (arg === '--latest-pine-run') {
      options.latestPineRun = true;
    } else if (arg === '--out') {
      options.outDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--limit') {
      options.limit = parsePositiveInteger(requireValue(arg, next), arg);
      index += 1;
    } else if (arg === '--no-images') {
      options.noImages = true;
    } else if (arg === '--sample') {
      options.sample = true;
    } else if (arg === '--overlay-width') {
      options.overlayWidth = parsePositiveInteger(requireValue(arg, next), arg);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.sample && !options.sessionId && !options.latestPineRun) {
    throw new Error('Provide --sessionId <id>, --latest-pine-run, or --sample.');
  }

  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function printHelpAndExit(): never {
  console.log(`
Usage:
  npm run ag3:dino-export -- --sessionId <reviewSessionId> --out /tmp/ag3-dino
  npm run ag3:dino-export -- --latest-pine-run --limit 10 --out /tmp/ag3-dino
  npm run ag3:dino-export -- --sample --out /tmp/ag3-dino-sample

Options:
  --sessionId <id>       Export a specific review session.
  --latest-pine-run      Export the latest pine/YOLO-looking review session.
  --out <dir>            Output directory. Defaults under tmp/ag3-dino-candidate-prep.
  --limit <n>            Limit assets for a small diagnostic bundle.
  --no-images            Export manifests only; skip image download and overlays.
  --overlay-width <px>   Max overlay PNG width. Default ${DEFAULT_OVERLAY_WIDTH}.
  --sample               Generate a local synthetic bundle for smoke testing.
`);
  process.exit(0);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseCenterBox(value: unknown): CenterBox | null {
  const parsed = parseJsonValue(value);

  if (
    parsed &&
    typeof parsed === 'object' &&
    'x' in parsed &&
    'y' in parsed &&
    'width' in parsed &&
    'height' in parsed
  ) {
    const candidate = parsed as { x: unknown; y: unknown; width: unknown; height: unknown };
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const width = Number(candidate.width);
    const height = Number(candidate.height);
    if ([x, y, width, height].every(Number.isFinite) && width > 0 && height > 0) {
      return { x, y, width, height };
    }
  }

  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed.map(Number);
    if ([x1, y1, x2, y2].every(Number.isFinite) && x2 > x1 && y2 > y1) {
      return {
        x: x1 + (x2 - x1) / 2,
        y: y1 + (y2 - y1) / 2,
        width: x2 - x1,
        height: y2 - y1,
      };
    }
  }

  return null;
}

function parsePolygon(value: unknown): number[][] | undefined {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed)) return undefined;
  const points = parsed
    .map((point) => {
      if (!Array.isArray(point) || point.length < 2) return null;
      const x = Number(point[0]);
      const y = Number(point[1]);
      return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
    })
    .filter((point): point is number[] => point != null);
  return points.length >= 2 ? points : undefined;
}

function clampBox(
  bbox: [number, number, number, number],
  width?: number | null,
  height?: number | null
): [number, number, number, number] {
  let [x1, y1, x2, y2] = bbox;
  if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
    x1 = Math.max(0, Math.min(width, x1));
    x2 = Math.max(0, Math.min(width, x2));
  }
  if (typeof height === 'number' && Number.isFinite(height) && height > 0) {
    y1 = Math.max(0, Math.min(height, y1));
    y2 = Math.max(0, Math.min(height, y2));
  }
  return [x1, y1, x2, y2];
}

function normalizeBoxFromCenter(
  centerBox: CenterBox | null,
  width?: number | null,
  height?: number | null
): [number, number, number, number] | null {
  if (!centerBox) return null;
  const [x1, y1, x2, y2] = centerBoxToCorner(centerBox);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return clampBox([x1, y1, x2, y2], width, height);
}

function parsePreprocessingMeta(value: unknown): YOLOPreprocessingMeta | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Partial<YOLOPreprocessingMeta>;
  if (
    typeof record.originalWidth === 'number' &&
    typeof record.originalHeight === 'number' &&
    typeof record.inferenceWidth === 'number' &&
    typeof record.inferenceHeight === 'number'
  ) {
    return record as YOLOPreprocessingMeta;
  }
  return null;
}

function safeName(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'asset';
}

async function ensureDirs(root: string): Promise<{
  imagesDir: string;
  overlaysDir: string;
  detectionsDir: string;
  exemplarsDir: string;
  candidatesDir: string;
}> {
  const dirs = {
    imagesDir: path.join(root, 'images'),
    overlaysDir: path.join(root, 'overlays'),
    detectionsDir: path.join(root, 'detections'),
    exemplarsDir: path.join(root, 'exemplars'),
    candidatesDir: path.join(root, 'candidates'),
  };
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })));
  return dirs;
}

async function downloadAssetImage(asset: ExportAsset, outputPath: string): Promise<Buffer> {
  let imageBuffer: Buffer;

  if (asset.s3Key) {
    imageBuffer = await S3Service.downloadFile(asset.s3Key, asset.s3Bucket || S3Service.bucketName);
  } else if (/^https?:\/\//i.test(asset.storageUrl)) {
    const response = await fetch(asset.storageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while downloading ${asset.storageUrl}`);
    }
    imageBuffer = Buffer.from(await response.arrayBuffer());
  } else {
    const localPath = asset.storageUrl.startsWith('/')
      ? path.join(process.cwd(), 'public', asset.storageUrl.replace(/^\//, ''))
      : path.resolve(process.cwd(), asset.storageUrl);
    imageBuffer = await fs.readFile(localPath);
  }

  await fs.writeFile(outputPath, imageBuffer);
  return imageBuffer;
}

function confidenceColor(confidence: number): string {
  if (confidence >= 0.75) return '#10b981';
  if (confidence >= 0.45) return '#f59e0b';
  return '#ef4444';
}

function svgEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function writeOverlay(options: {
  imageBuffer: Buffer;
  outputPath: string;
  detections: ExportDetection[];
  overlayWidth: number;
}): Promise<{ width: number; height: number }> {
  const metadata = await sharp(options.imageBuffer).metadata();
  const sourceWidth = metadata.width || 1;
  const sourceHeight = metadata.height || 1;
  const scale = sourceWidth > options.overlayWidth ? options.overlayWidth / sourceWidth : 1;
  const width = Math.round(sourceWidth * scale);
  const height = Math.round(sourceHeight * scale);

  const rects = options.detections
    .map((detection) => {
      const [x1, y1, x2, y2] = detection.bbox.map((value) => value * scale);
      const color = confidenceColor(detection.confidence);
      const label = `${Math.round(detection.confidence * 100)}%`;
      return `
        <rect x="${x1.toFixed(1)}" y="${y1.toFixed(1)}" width="${(x2 - x1).toFixed(1)}" height="${(y2 - y1).toFixed(1)}" fill="none" stroke="${color}" stroke-width="3"/>
        <rect x="${x1.toFixed(1)}" y="${Math.max(0, y1 - 22).toFixed(1)}" width="${Math.max(36, label.length * 11)}" height="22" fill="${color}" rx="4"/>
        <text x="${(x1 + 5).toFixed(1)}" y="${Math.max(16, y1 - 6).toFixed(1)}" fill="white" font-family="Arial, sans-serif" font-size="14" font-weight="700">${svgEscape(label)}</text>
      `;
    })
    .join('\n');

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      ${rects}
    </svg>
  `;

  await sharp(options.imageBuffer)
    .resize({ width, withoutEnlargement: true })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toFile(options.outputPath);

  return { width: sourceWidth, height: sourceHeight };
}

function makeDetectionFromPrismaDetection(
  detection: {
    id: string;
    assetId: string;
    type: string;
    className: string;
    confidence: number | null;
    boundingBox: unknown;
    preprocessingMeta: unknown;
    verified: boolean;
    rejected: boolean;
    userCorrected: boolean;
    customModelId: string | null;
    inferenceJobId: string | null;
    metadata: unknown;
  },
  asset: ExportAsset
): ExportDetection | null {
  let centerBox = parseCenterBox(detection.boundingBox);
  const preprocessingMeta = parsePreprocessingMeta(detection.preprocessingMeta);
  if (centerBox && preprocessingMeta) {
    centerBox = rescaleToOriginalWithMeta(centerBox, preprocessingMeta);
  }
  const bbox = normalizeBoxFromCenter(centerBox, asset.imageWidth, asset.imageHeight);
  if (!bbox) return null;

  return {
    id: detection.id,
    source: detection.type === 'YOLO_LOCAL' ? 'yolo_detection' : 'ai_detection',
    sourceId: detection.id,
    assetId: detection.assetId,
    className: detection.className || DEFAULT_CLASS_NAME,
    confidence: detection.confidence ?? 0,
    bbox,
    status: detection.rejected
      ? 'rejected'
      : detection.verified || detection.userCorrected
        ? 'accepted'
        : 'pending',
    metadata: {
      type: detection.type,
      customModelId: detection.customModelId,
      inferenceJobId: detection.inferenceJobId,
      rawMetadata: detection.metadata,
    },
  };
}

function makeDetectionFromPending(
  pending: {
    id: string;
    assetId: string;
    weedType: string;
    confidence: number;
    similarity: number | null;
    bbox: unknown;
    polygon: unknown;
    status: string;
    batchJobId: string;
  },
  asset: ExportAsset
): ExportDetection | null {
  const polygon = parsePolygon(pending.polygon);
  const centerBox = parseCenterBox(pending.bbox) || polygonToCenterBox(polygon || []);
  const bbox = normalizeBoxFromCenter(centerBox, asset.imageWidth, asset.imageHeight);
  if (!bbox) return null;

  return {
    id: pending.id,
    source: 'pending_annotation',
    sourceId: pending.id,
    assetId: pending.assetId,
    className: pending.weedType || DEFAULT_CLASS_NAME,
    confidence: pending.confidence,
    similarity: pending.similarity,
    bbox,
    polygon,
    status: pending.status === 'ACCEPTED'
      ? 'accepted'
      : pending.status === 'REJECTED'
        ? 'rejected'
        : 'pending',
    metadata: {
      batchJobId: pending.batchJobId,
    },
  };
}

async function resolveSession(options: CliOptions) {
  if (options.sessionId) {
    const session = await prisma.reviewSession.findUnique({
      where: { id: options.sessionId },
      include: { project: { select: { id: true, name: true } } },
    });
    if (!session) throw new Error(`Review session not found: ${options.sessionId}`);
    return session;
  }

  const session = await prisma.reviewSession.findFirst({
    where: {
      OR: [
        { weedTypeFilter: { contains: 'Pine' } },
        { weedTypeFilter: { contains: 'pine' } },
        { yoloModelName: { contains: 'pine' } },
        { yoloModelName: { contains: 'sapling' } },
        { projectId: GLASSHOUSE_PROJECT_ID },
      ],
    },
    orderBy: { createdAt: 'desc' },
    include: { project: { select: { id: true, name: true } } },
  });

  if (!session) {
    throw new Error('No pine-looking review session found. Provide --sessionId explicitly.');
  }
  return session;
}

async function exportActualBundle(options: CliOptions): Promise<ExportBundle> {
  const session = await resolveSession(options);
  const outRoot = path.resolve(
    options.outDir || path.join(DEFAULT_OUT_ROOT, session.id)
  );
  const dirs = await ensureDirs(outRoot);
  const assetIds = (await resolveReviewSessionAssetIds(prisma, session)).slice(
    0,
    options.limit ?? Number.POSITIVE_INFINITY
  );
  if (assetIds.length === 0) {
    throw new Error(`Review session ${session.id} has no resolvable assets.`);
  }

  const assetRows = await prisma.asset.findMany({
    where: { id: { in: assetIds }, projectId: session.projectId },
    select: {
      id: true,
      fileName: true,
      storageUrl: true,
      s3Key: true,
      s3Bucket: true,
      storageType: true,
      imageWidth: true,
      imageHeight: true,
    },
  });
  const assetOrder = new Map(assetIds.map((assetId, index) => [assetId, index]));
  const assets = assetRows
    .sort((left, right) => (assetOrder.get(left.id) ?? 0) - (assetOrder.get(right.id) ?? 0))
    .map((asset) => asset as ExportAsset);
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));

  const inferenceJobIds = toStringArray(session.inferenceJobIds);
  const batchJobIds = toStringArray(session.batchJobIds);
  const exportAssetIds = assets.map((asset) => asset.id);

  const detectionSelect = {
    id: true,
    assetId: true,
    type: true,
    className: true,
    confidence: true,
    boundingBox: true,
    preprocessingMeta: true,
    verified: true,
    rejected: true,
    userCorrected: true,
    customModelId: true,
    inferenceJobId: true,
    metadata: true,
  } as const;

  const linkedDetectionRows = inferenceJobIds.length > 0
    ? await prisma.detection.findMany({
        where: {
          assetId: { in: exportAssetIds },
          inferenceJobId: { in: inferenceJobIds },
        },
        select: detectionSelect,
      })
    : [];

  const detectionRows = linkedDetectionRows.length > 0
    ? linkedDetectionRows
    : await prisma.detection.findMany({
        where: {
          assetId: { in: exportAssetIds },
          OR: [
            { customModelId: PINE_MODEL_ID },
            { createdAt: { gte: session.createdAt }, type: 'YOLO_LOCAL' as const },
          ],
        },
        select: detectionSelect,
      });

  if (inferenceJobIds.length > 0 && linkedDetectionRows.length === 0 && detectionRows.length > 0) {
    console.warn(
      `No detections were linked to inference job(s) ${inferenceJobIds.join(', ')}; ` +
      `exporting ${detectionRows.length} model detections from the same asset set instead.`
    );
  }

  const pendingRows = batchJobIds.length > 0
    ? await prisma.pendingAnnotation.findMany({
        where: {
          assetId: { in: exportAssetIds },
          batchJobId: { in: batchJobIds },
        },
        select: {
          id: true,
          assetId: true,
          weedType: true,
          confidence: true,
          similarity: true,
          bbox: true,
          polygon: true,
          status: true,
          batchJobId: true,
        },
      })
    : [];

  const detections = [
    ...detectionRows
      .map((detection) => {
        const asset = assetById.get(detection.assetId);
        return asset ? makeDetectionFromPrismaDetection(detection, asset) : null;
      }),
    ...pendingRows
      .map((pending) => {
        const asset = assetById.get(pending.assetId);
        return asset ? makeDetectionFromPending(pending, asset) : null;
      }),
  ].filter((detection): detection is ExportDetection => detection != null);

  const detectionsByAsset = new Map<string, ExportDetection[]>();
  for (const detection of detections) {
    const list = detectionsByAsset.get(detection.assetId) || [];
    list.push(detection);
    detectionsByAsset.set(detection.assetId, list);
  }

  const manifestAssets: ExportBundle['assets'] = [];
  for (const asset of assets) {
    const imageName = `${assetOrder.get(asset.id) ?? 0}-${safeName(asset.fileName)}.jpg`;
    const imagePath = options.noImages ? null : path.join(dirs.imagesDir, imageName);
    const overlayPath = options.noImages
      ? null
      : path.join(dirs.overlaysDir, `${assetOrder.get(asset.id) ?? 0}-${safeName(asset.fileName)}-overlay.png`);

    let width = asset.imageWidth ?? null;
    let height = asset.imageHeight ?? null;
    if (!options.noImages && imagePath && overlayPath) {
      try {
        const buffer = await downloadAssetImage(asset, imagePath);
        const overlayMeta = await writeOverlay({
          imageBuffer: buffer,
          outputPath: overlayPath,
          detections: detectionsByAsset.get(asset.id) || [],
          overlayWidth: options.overlayWidth,
        });
        width = overlayMeta.width;
        height = overlayMeta.height;
      } catch (error) {
        console.warn(`Warning: failed image/overlay for ${asset.fileName}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    manifestAssets.push({
      assetId: asset.id,
      fileName: asset.fileName,
      imagePath,
      overlayPath,
      imageWidth: width,
      imageHeight: height,
      detectionCount: detectionsByAsset.get(asset.id)?.length || 0,
    });
  }

  return writeBundle({
    root: outRoot,
    dirs,
    session: {
      id: session.id,
      projectId: session.projectId,
      workflowType: session.workflowType,
      createdAt: session.createdAt.toISOString(),
      yoloModelName: session.yoloModelName,
      weedTypeFilter: session.weedTypeFilter,
      inferenceJobIds,
      batchJobIds,
    },
    project: {
      id: session.project.id,
      name: session.project.name,
    },
    assets: manifestAssets,
    detections,
  });
}

async function exportSampleBundle(options: CliOptions): Promise<ExportBundle> {
  const outRoot = path.resolve(options.outDir || path.join(DEFAULT_OUT_ROOT, 'sample'));
  const dirs = await ensureDirs(outRoot);
  const assets: ExportBundle['assets'] = [];
  const detections: ExportDetection[] = [
    {
      id: 'sample-detection-1',
      source: 'yolo_detection',
      sourceId: 'sample-detection-1',
      assetId: 'sample-asset-1',
      className: DEFAULT_CLASS_NAME,
      confidence: 0.82,
      bbox: [220, 150, 295, 225],
      status: 'pending',
    },
    {
      id: 'sample-detection-2',
      source: 'yolo_detection',
      sourceId: 'sample-detection-2',
      assetId: 'sample-asset-1',
      className: DEFAULT_CLASS_NAME,
      confidence: 0.37,
      bbox: [620, 380, 690, 455],
      status: 'pending',
    },
  ];

  const imagePath = path.join(dirs.imagesDir, '0-sample-pine-image.jpg');
  const overlayPath = path.join(dirs.overlaysDir, '0-sample-pine-image-overlay.png');
  const sampleBuffer = await sharp({
    create: {
      width: 1024,
      height: 768,
      channels: 3,
      background: { r: 208, g: 199, b: 181 },
    },
  })
    .composite([
      {
        input: Buffer.from(`
          <svg width="1024" height="768" xmlns="http://www.w3.org/2000/svg">
            <rect width="1024" height="768" fill="#d0c7b5"/>
            <circle cx="260" cy="185" r="38" fill="#34d399"/>
            <circle cx="650" cy="420" r="34" fill="#65a30d"/>
            <circle cx="810" cy="210" r="30" fill="#15803d"/>
            <line x1="120" y1="120" x2="940" y2="650" stroke="#7c6f64" stroke-width="8" opacity="0.45"/>
          </svg>
        `),
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  await fs.writeFile(imagePath, sampleBuffer);
  await writeOverlay({
    imageBuffer: sampleBuffer,
    outputPath: overlayPath,
    detections,
    overlayWidth: options.overlayWidth,
  });

  assets.push({
    assetId: 'sample-asset-1',
    fileName: 'sample-pine-image.jpg',
    imagePath,
    overlayPath,
    imageWidth: 1024,
    imageHeight: 768,
    detectionCount: detections.length,
  });

  return writeBundle({
    root: outRoot,
    dirs,
    session: {
      id: 'sample-review-session',
      projectId: GLASSHOUSE_PROJECT_ID,
      workflowType: 'yolo_review',
      createdAt: new Date().toISOString(),
      yoloModelName: 'pine-saplings-yolo11n-seg-glasshouse-v1',
      weedTypeFilter: DEFAULT_CLASS_NAME,
      inferenceJobIds: ['sample-inference-job'],
      batchJobIds: [],
    },
    project: {
      id: GLASSHOUSE_PROJECT_ID,
      name: 'Sample Glasshouse Project',
    },
    assets,
    detections,
  });
}

async function writeBundle(args: {
  root: string;
  dirs: Awaited<ReturnType<typeof ensureDirs>>;
  session: ExportBundle['sourceSession'];
  project: ExportBundle['project'];
  assets: ExportBundle['assets'];
  detections: ExportDetection[];
}): Promise<ExportBundle> {
  const detectionsPath = path.join(args.dirs.detectionsDir, 'current-detections.json');
  const missedTemplatePath = path.join(args.dirs.exemplarsDir, 'missed-saplings.template.json');
  const candidateTemplatePath = path.join(args.dirs.candidatesDir, 'dino-candidates.template.json');
  const manifestPath = path.join(args.root, 'manifest.json');

  await fs.writeFile(detectionsPath, `${JSON.stringify(args.detections, null, 2)}\n`);
  await fs.writeFile(missedTemplatePath, `${JSON.stringify(makeMissedTemplate(args), null, 2)}\n`);
  await fs.writeFile(candidateTemplatePath, `${JSON.stringify(makeCandidateTemplate(args), null, 2)}\n`);

  const bundle: ExportBundle = {
    schemaVersion: 'ag3-dino-candidate-prep/v1',
    createdAt: new Date().toISOString(),
    sourceSession: args.session,
    project: args.project,
    output: {
      root: args.root,
      imagesDir: args.dirs.imagesDir,
      overlaysDir: args.dirs.overlaysDir,
      detectionsPath,
      missedTemplatePath,
      candidateTemplatePath,
    },
    assets: args.assets,
    totals: {
      assets: args.assets.length,
      detections: args.detections.length,
    },
  };

  await fs.writeFile(manifestPath, `${JSON.stringify(bundle, null, 2)}\n`);
  await fs.writeFile(path.join(args.root, 'README.md'), makeReadme(bundle));
  return bundle;
}

function makeMissedTemplate(args: {
  session: ExportBundle['sourceSession'];
  project: ExportBundle['project'];
  assets: ExportBundle['assets'];
}) {
  return {
    schemaVersion: 'ag3-missed-saplings/v1',
    sourceSessionId: args.session.id,
    projectId: args.project.id,
    instructions: [
      'Manas marks saplings that YOLO/SAM missed on the exported image or overlay.',
      'Use pixel boxes in source image coordinates where possible: [x1, y1, x2, y2].',
      'If only a point is available, provide point: [x, y] and an approximate boxSize.',
      'Keep these as missed positive exemplars only; do not include existing detected saplings.',
    ],
    exemplars: args.assets.map((asset) => ({
      assetId: asset.assetId,
      fileName: asset.fileName,
      imagePath: asset.imagePath,
      overlayPath: asset.overlayPath,
      missed: [] as Array<{
        label: string;
        bbox?: [number, number, number, number];
        point?: [number, number];
        boxSize?: number;
        notes?: string;
      }>,
    })),
  };
}

function makeCandidateTemplate(args: {
  session: ExportBundle['sourceSession'];
  project: ExportBundle['project'];
  assets: ExportBundle['assets'];
}) {
  const firstAsset = args.assets[0];
  return {
    schemaVersion: 'ag3-dino-candidates/v1',
    sourceSessionId: args.session.id,
    projectId: args.project.id,
    className: DEFAULT_CLASS_NAME,
    generator: {
      name: 'DINO candidate mining',
      version: 'manual-template',
      notes: 'Replace candidates with DINO output before running npm run ag3:dino-import.',
    },
    candidates: firstAsset
      ? [
          {
            assetId: firstAsset.assetId,
            className: DEFAULT_CLASS_NAME,
            confidence: 0.5,
            similarity: 0.75,
            bbox: [100, 100, 150, 150],
            polygon: [
              [100, 100],
              [150, 100],
              [150, 150],
              [100, 150],
            ],
            notes: 'Example candidate only; delete before import.',
          },
        ]
      : [],
  };
}

function makeReadme(bundle: ExportBundle): string {
  return `# AG-3 DINO Candidate Prep Bundle

Source session: ${bundle.sourceSession.id}
Project: ${bundle.project.name || bundle.project.id}
Created: ${bundle.createdAt}

## Contents
- \`images/\`: source images for missed-sapling marking.
- \`overlays/\`: current detection overlays, scaled for quick review.
- \`detections/current-detections.json\`: exported current detections.
- \`exemplars/missed-saplings.template.json\`: fill this with missed sapling boxes/points.
- \`candidates/dino-candidates.template.json\`: shape expected by the DINO candidate importer.

## Operator Loop
1. Review the overlay PNGs and mark missed saplings on the source images.
2. Convert missed saplings to positive exemplar boxes in \`exemplars/missed-saplings.template.json\`.
3. Run DINO candidate mining outside the app using those missed exemplars.
4. Save generated candidates as \`candidates/dino-candidates.json\`.
5. Import candidates with:

\`\`\`bash
npm run ag3:dino-import -- --candidates ${path.join(bundle.output.root, 'candidates/dino-candidates.json')} --create-review-session
\`\`\`

Imported DINO candidates stay \`PENDING\`; Manas reviews them normally before they can enter training.
`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = options.sample
    ? await exportSampleBundle(options)
    : await exportActualBundle(options);

  console.log(JSON.stringify({
    ok: true,
    root: bundle.output.root,
    sessionId: bundle.sourceSession.id,
    assets: bundle.totals.assets,
    detections: bundle.totals.detections,
    manifest: path.join(bundle.output.root, 'manifest.json'),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect().catch(() => undefined);
  });
