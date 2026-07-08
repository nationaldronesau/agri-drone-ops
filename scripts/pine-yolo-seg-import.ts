import fs from 'node:fs/promises';
import path from 'node:path';
import prisma from '@/lib/db';
import { sanitizeClassName } from '@/lib/services/dataset-preparation';
import {
  importDinoCandidates,
  type CandidateFile,
  type CandidateInput,
} from './ag3-dino-import';

interface CliOptions {
  labelsDir: string;
  projectId: string;
  sessionName?: string;
  className: string;
  dryRun: boolean;
}

interface AssetLookup {
  id: string;
  fileName: string;
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface ParsedYoloSegRow {
  sourceClassId: string;
  points: Array<[number, number]>;
}

interface BuildCandidatesResult {
  candidateFile: CandidateFile;
  summary: {
    labelFiles: number;
    matchedAssets: number;
    candidates: number;
    className: string;
    stemToAssetId: Record<string, string>;
  };
}

function parseArgs(argv: string[]): CliOptions {
  const options: Partial<CliOptions> = {
    className: 'pine_sapling',
    dryRun: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--labels-dir') {
      options.labelsDir = requireValue(arg, next);
      index += 1;
    } else if (arg === '--project') {
      options.projectId = requireValue(arg, next);
      index += 1;
    } else if (arg === '--session-name') {
      options.sessionName = requireValue(arg, next);
      index += 1;
    } else if (arg === '--class') {
      options.className = requireValue(arg, next);
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelpAndExit();
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.labelsDir) {
    throw new Error('Provide --labels-dir <dir>.');
  }
  if (!options.projectId) {
    throw new Error('Provide --project <projectId>.');
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
  npm run ag3:pine-yolo-seg-import -- --labels-dir /path/to/labels --project <projectId> --session-name "Pine SAM3 batch"
  npm run ag3:pine-yolo-seg-import -- --labels-dir /path/to/labels --project <projectId> --dry-run

YOLO-seg label rows must be: class x1 y1 x2 y2 ... with normalized polygon coordinates.
The label filename stem must match an image filename stem in the project.
`);
  process.exit(0);
}

export function parseYoloSegLabelLine(line: string, source: string): ParsedYoloSegRow {
  const trimmed = line.trim();
  if (!trimmed) {
    throw new Error(`${source}: empty YOLO-seg row`);
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 7) {
    throw new Error(`${source}: YOLO-seg row must contain class plus at least three points`);
  }
  if ((parts.length - 1) % 2 !== 0) {
    throw new Error(`${source}: YOLO-seg row has an odd number of polygon coordinates`);
  }

  const sourceClassId = parts[0];
  const coordinates = parts.slice(1).map((value) => Number(value));
  if (!coordinates.every(Number.isFinite)) {
    throw new Error(`${source}: YOLO-seg row contains a non-numeric coordinate`);
  }

  const points: Array<[number, number]> = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    const x = coordinates[index];
    const y = coordinates[index + 1];
    if (x < 0 || x > 1 || y < 0 || y > 1) {
      throw new Error(`${source}: normalized polygon coordinate is outside 0..1`);
    }
    points.push([x, y]);
  }

  return { sourceClassId, points };
}

export function denormalizeYoloSegRow(
  row: ParsedYoloSegRow,
  imageWidth: number,
  imageHeight: number
): { polygon: number[][]; bbox: [number, number, number, number] } {
  const polygon = row.points.map(([x, y]) => [x * imageWidth, y * imageHeight]);
  const xs = polygon.map((point) => point[0]);
  const ys = polygon.map((point) => point[1]);
  return {
    polygon,
    bbox: [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ],
  };
}

export function buildStemAssetMap(assets: AssetLookup[]): Map<string, AssetLookup[]> {
  const byStem = new Map<string, AssetLookup[]>();
  for (const asset of assets) {
    const stem = path.parse(asset.fileName).name;
    const group = byStem.get(stem) || [];
    group.push(asset);
    byStem.set(stem, group);
  }
  return byStem;
}

export async function buildPineYoloSegCandidates(args: {
  labelsDir: string;
  projectId: string;
  className: string;
  assets: AssetLookup[];
}): Promise<BuildCandidatesResult> {
  const labelsDir = path.resolve(args.labelsDir);
  const entries = await fs.readdir(labelsDir, { withFileTypes: true });
  const labelFiles = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.txt')
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  if (labelFiles.length === 0) {
    throw new Error(`No .txt label files found in ${labelsDir}.`);
  }

  const className = sanitizeClassName(args.className);
  if (!className) {
    throw new Error(`Class name "${args.className}" is empty after sanitization.`);
  }

  const assetsByStem = buildStemAssetMap(args.assets);
  const candidates: CandidateInput[] = [];
  const stemToAssetId: Record<string, string> = {};

  for (const labelFile of labelFiles) {
    const stem = path.parse(labelFile).name;
    const matches = assetsByStem.get(stem) || [];
    if (matches.length === 0) {
      throw new Error(`${labelFile}: no asset in project ${args.projectId} has filename stem "${stem}".`);
    }
    if (matches.length > 1) {
      throw new Error(
        `${labelFile}: filename stem "${stem}" is ambiguous across assets ${matches
          .map((asset) => `${asset.id} (${asset.fileName})`)
          .join(', ')}.`
      );
    }

    const asset = matches[0];
    if (!asset.imageWidth || !asset.imageHeight) {
      throw new Error(
        `${labelFile}: asset ${asset.id} (${asset.fileName}) is missing imageWidth/imageHeight; bulk-register or backfill dimensions before import.`
      );
    }

    stemToAssetId[stem] = asset.id;
    const raw = await fs.readFile(path.join(labelsDir, labelFile), 'utf8');
    const lines = raw.split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex].trim();
      if (!line) continue;
      const parsed = parseYoloSegLabelLine(line, `${labelFile}:${lineIndex + 1}`);
      const { polygon, bbox } = denormalizeYoloSegRow(
        parsed,
        asset.imageWidth,
        asset.imageHeight
      );
      candidates.push({
        assetId: asset.id,
        className,
        confidence: 1,
        bbox,
        polygon,
        notes: `YOLO-seg import ${labelFile}:${lineIndex + 1}`,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No YOLO-seg rows found in ${labelsDir}.`);
  }

  return {
    candidateFile: {
      schemaVersion: 'ag3-dino-candidates/v1',
      projectId: args.projectId,
      className,
      generator: {
        source: 'pine-yolo-seg-import',
        labelsDir,
      },
      candidates,
    },
    summary: {
      labelFiles: labelFiles.length,
      matchedAssets: Object.keys(stemToAssetId).length,
      candidates: candidates.length,
      className,
      stemToAssetId,
    },
  };
}

async function resolveProjectOwner(projectId: string): Promise<{ teamId: string; createdById: string }> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
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

  if (!project) {
    throw new Error(`Project not found: ${projectId}`);
  }
  const createdById = project.team.members[0]?.userId;
  if (!createdById) {
    throw new Error(`Project ${projectId} has no team members to own the review session.`);
  }

  return { teamId: project.teamId, createdById };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const assets = await prisma.asset.findMany({
    where: { projectId: options.projectId },
    select: {
      id: true,
      fileName: true,
      imageWidth: true,
      imageHeight: true,
    },
  });

  const built = await buildPineYoloSegCandidates({
    labelsDir: options.labelsDir,
    projectId: options.projectId,
    className: options.className,
    assets,
  });

  const owner = await resolveProjectOwner(options.projectId);
  const result = await importDinoCandidates({
    candidateFile: built.candidateFile,
    createReviewSession: true,
    dryRun: options.dryRun,
    reviewSessionOwner: {
      ...owner,
      yoloModelName: options.sessionName || 'Pine YOLO-seg import',
    },
  });

  console.log(JSON.stringify({
    ...result,
    dryRun: options.dryRun || result.dryRun || undefined,
    importSummary: built.summary,
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
