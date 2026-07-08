import fs from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import prisma from '@/lib/db';
import { S3Service } from '@/lib/services/s3';

type StorageMode = 's3' | 'local';

interface CliOptions {
  imagesDir: string;
  projectRef: string;
  flightSession?: string;
}

interface ProjectContext {
  id: string;
  name: string;
  teamId: string;
  createdById: string;
}

interface ExistingAsset {
  id: string;
  fileName: string;
}

interface ImageCandidate {
  fileName: string;
  filePath: string;
}

export interface BulkRegistrationPlan {
  toRegister: ImageCandidate[];
  skipped: Array<{ fileName: string; assetId: string; reason: string }>;
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--images-dir') {
      options.imagesDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--project' || arg === '--project-id') {
      options.projectRef = requireValue(arg, next);
      index += 1;
    } else if (arg === '--flight-session') {
      options.flightSession = requireValue(arg, next);
      index += 1;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.imagesDir) {
    throw new Error('Provide --images-dir <dir>.');
  }
  if (!options.projectRef) {
    throw new Error('Provide --project <name-or-id>.');
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
  npm run ag3:pine-bulk-register -- --images-dir /path/to/images --project <name-or-id> --flight-session "Pine SAM3 batch"

Environment:
  PINE_BULK_REGISTER_STORAGE=s3|local  Defaults to s3.
  PINE_BULK_REGISTER_LOCAL_DIR=public/uploads/ag3-pine  Required only when storage=local if you want a custom root.
  AWS_REGION, AWS_S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY are used for storage=s3.
`);
  process.exit(0);
}

function fileStem(fileName: string): string {
  return path.parse(fileName).name;
}

export function planBulkRegistration(
  images: ImageCandidate[],
  existingAssets: ExistingAsset[]
): BulkRegistrationPlan {
  const existingByStem = new Map<string, ExistingAsset>();
  for (const asset of existingAssets) {
    existingByStem.set(fileStem(asset.fileName), asset);
  }

  const seenInputStems = new Set<string>();
  const toRegister: ImageCandidate[] = [];
  const skipped: BulkRegistrationPlan['skipped'] = [];

  for (const image of images) {
    const stem = fileStem(image.fileName);
    const existing = existingByStem.get(stem);
    if (existing) {
      skipped.push({
        fileName: image.fileName,
        assetId: existing.id,
        reason: 'filename_stem_already_registered',
      });
      continue;
    }
    if (seenInputStems.has(stem)) {
      skipped.push({
        fileName: image.fileName,
        assetId: '',
        reason: 'duplicate_input_filename_stem',
      });
      continue;
    }
    seenInputStems.add(stem);
    toRegister.push(image);
  }

  return { toRegister, skipped };
}

async function listJpegImages(imagesDir: string): Promise<ImageCandidate[]> {
  const root = path.resolve(imagesDir);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && /\.(jpe?g)$/i.test(entry.name))
    .map((entry) => ({
      fileName: entry.name,
      filePath: path.join(root, entry.name),
    }))
    .sort((left, right) => left.fileName.localeCompare(right.fileName));

  if (images.length === 0) {
    throw new Error(`No JPG images found in ${root}.`);
  }

  return images;
}

async function resolveProject(projectRef: string): Promise<ProjectContext> {
  const projects = await prisma.project.findMany({
    where: {
      OR: [{ id: projectRef }, { name: projectRef }],
    },
    select: {
      id: true,
      name: true,
      teamId: true,
      team: {
        select: {
          members: {
            orderBy: { createdAt: 'asc' },
            take: 1,
            select: { userId: true },
          },
        },
      },
    },
  });

  if (projects.length === 0) {
    throw new Error(`Project not found by id or name: ${projectRef}`);
  }
  if (projects.length > 1) {
    throw new Error(`Project reference "${projectRef}" matched multiple projects; use the project id.`);
  }

  const project = projects[0];
  const createdById = project.team.members[0]?.userId;
  if (!createdById) {
    throw new Error(`Project ${project.id} has no team members to own imported assets.`);
  }

  return {
    id: project.id,
    name: project.name,
    teamId: project.teamId,
    createdById,
  };
}

function resolveStorageMode(): StorageMode {
  const value = (process.env.PINE_BULK_REGISTER_STORAGE || 's3').toLowerCase();
  if (value === 's3' || value === 'local') return value;
  throw new Error('PINE_BULK_REGISTER_STORAGE must be "s3" or "local".');
}

function mimeTypeFor(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return 'application/octet-stream';
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

async function storeImage(args: {
  projectId: string;
  createdById: string;
  image: ImageCandidate;
  buffer: Buffer;
  contentType: string;
  flightSession?: string;
  storageMode: StorageMode;
}): Promise<{
  storageUrl: string;
  storageType: string;
  s3Key: string | null;
  s3Bucket: string | null;
}> {
  if (args.storageMode === 'local') {
    const localRoot = path.resolve(process.env.PINE_BULK_REGISTER_LOCAL_DIR || 'public/uploads/ag3-pine');
    const relativeParts = [
      args.projectId,
      args.flightSession ? sanitizePathSegment(args.flightSession) : 'default',
      args.image.fileName,
    ];
    const targetPath = path.join(localRoot, ...relativeParts);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.copyFile(args.image.filePath, targetPath);
    const publicRoot = path.resolve('public');
    const storageUrl = path.relative(publicRoot, targetPath).split(path.sep).join('/');
    return {
      storageUrl: `/${storageUrl}`,
      storageType: 'local',
      s3Key: null,
      s3Bucket: null,
    };
  }

  const key = S3Service.generateKey({
    userId: args.createdById,
    projectId: args.projectId,
    fileName: args.image.fileName,
    contentType: args.contentType,
    flightSession: args.flightSession,
  });
  await S3Service.uploadBuffer(args.buffer, key, args.contentType);
  const cloudFrontBase =
    process.env.CLOUDFRONT_BASE_URL ??
    process.env.NEXT_PUBLIC_CLOUDFRONT_BASE_URL ??
    null;
  const storageUrl = cloudFrontBase
    ? `${cloudFrontBase.replace(/\/$/, '')}/${key}`
    : S3Service.buildPublicUrl(key);

  return {
    storageUrl,
    storageType: 's3',
    s3Key: key,
    s3Bucket: S3Service.bucketName,
  };
}

async function extractMetadata(buffer: Buffer, fileName: string): Promise<{
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  warnings: string[];
}> {
  const warnings: string[] = [];
  try {
    const gps = await exifr.gps(buffer);
    if (!gps) {
      warnings.push(`${fileName}: no GPS EXIF found`);
      return { gpsLatitude: null, gpsLongitude: null, altitude: null, warnings };
    }

    const gpsLatitude = Number.isFinite(gps.latitude) ? gps.latitude ?? null : null;
    const gpsLongitude = Number.isFinite(gps.longitude) ? gps.longitude ?? null : null;
    const altitude = Number.isFinite(gps.altitude) ? gps.altitude ?? null : null;
    if (gpsLatitude == null || gpsLongitude == null) {
      warnings.push(`${fileName}: GPS EXIF was present but incomplete or invalid`);
    }
    return { gpsLatitude, gpsLongitude, altitude, warnings };
  } catch (error) {
    warnings.push(
      `${fileName}: EXIF/GPS read failed: ${error instanceof Error ? error.message : 'unknown error'}`
    );
    return { gpsLatitude: null, gpsLongitude: null, altitude: null, warnings };
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const project = await resolveProject(options.projectRef);
  const images = await listJpegImages(options.imagesDir);
  const existingAssets = await prisma.asset.findMany({
    where: { projectId: project.id },
    select: { id: true, fileName: true },
  });
  const plan = planBulkRegistration(images, existingAssets);
  const storageMode = resolveStorageMode();
  const stemToAssetId: Record<string, string> = {};
  const warnings: string[] = [];

  for (const skipped of plan.skipped) {
    if (skipped.assetId) {
      stemToAssetId[fileStem(skipped.fileName)] = skipped.assetId;
    }
  }

  for (const image of plan.toRegister) {
    const buffer = await fs.readFile(image.filePath);
    const sharpMetadata = await sharp(buffer).metadata();
    if (!sharpMetadata.width || !sharpMetadata.height) {
      throw new Error(`${image.fileName}: sharp could not determine image width/height.`);
    }

    const stat = await fs.stat(image.filePath);
    const contentType = mimeTypeFor(image.fileName);
    const gps = await extractMetadata(buffer, image.fileName);
    warnings.push(...gps.warnings);
    const stored = await storeImage({
      projectId: project.id,
      createdById: project.createdById,
      image,
      buffer,
      contentType,
      flightSession: options.flightSession,
      storageMode,
    });

    const asset = await prisma.asset.create({
      data: {
        fileName: image.fileName,
        storageUrl: stored.storageUrl,
        mimeType: contentType,
        fileSize: stat.size,
        s3Key: stored.s3Key,
        s3Bucket: stored.s3Bucket,
        storageType: stored.storageType,
        gpsLatitude: gps.gpsLatitude,
        gpsLongitude: gps.gpsLongitude,
        altitude: gps.altitude,
        imageWidth: sharpMetadata.width,
        imageHeight: sharpMetadata.height,
        metadata: {
          source: 'pine-bulk-register',
          originalPath: path.resolve(image.filePath),
          importedAt: new Date().toISOString(),
          warnings: gps.warnings,
        },
        projectId: project.id,
        createdById: project.createdById,
        flightSession: options.flightSession || null,
      },
      select: { id: true },
    });

    stemToAssetId[fileStem(image.fileName)] = asset.id;
  }

  console.log(JSON.stringify({
    ok: true,
    projectId: project.id,
    projectName: project.name,
    storageMode,
    flightSession: options.flightSession || null,
    discoveredImages: images.length,
    registered: plan.toRegister.length,
    skipped: plan.skipped.length,
    warnings,
    stemToAssetId,
    skippedFiles: plan.skipped,
  }, null, 2));
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
