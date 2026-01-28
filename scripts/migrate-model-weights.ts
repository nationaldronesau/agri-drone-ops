/* eslint-disable no-console */
import prisma from '@/lib/db';
import { S3Service } from '@/lib/services/s3';

type ModelRow = {
  id: string;
  name: string;
  version: number;
  s3Path: string;
  s3Bucket: string;
  weightsFile: string;
};

function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function parseS3Path(path: string): { bucket: string; keyPrefix: string } | null {
  if (!path.startsWith('s3://')) return null;
  const withoutScheme = path.replace('s3://', '');
  const [bucket, ...rest] = withoutScheme.split('/');
  if (!bucket) return null;
  return { bucket, keyPrefix: rest.join('/') };
}

function toCanonicalPrefix(model: ModelRow): string {
  return `models/${model.name}/v${model.version}`;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(
      [
        'Usage: npm run migrate:model-weights -- [options]',
        '',
        'Options:',
        '  --apply            Apply changes (default is dry-run)',
        '  --team <teamId>    Limit to a team',
        '  --model <modelId>  Limit to a specific trained model',
        '  --name <name>      Limit to models with this name',
        '  --version <num>    Limit to a specific model version',
        '  --limit <num>      Limit number of models processed',
        '',
        'Examples:',
        '  npm run migrate:model-weights -- --apply',
        '  npm run migrate:model-weights -- --team team_123 --apply',
        '  npm run migrate:model-weights -- --model mdl_123 --apply',
      ].join('\n')
    );
    return;
  }

  const apply = hasFlag(argv, '--apply');
  const teamId = getArgValue(argv, '--team');
  const modelId = getArgValue(argv, '--model');
  const name = getArgValue(argv, '--name');
  const versionValue = getArgValue(argv, '--version');
  const limitValue = getArgValue(argv, '--limit');

  const version = versionValue ? Number.parseInt(versionValue, 10) : undefined;
  const limit = limitValue ? Number.parseInt(limitValue, 10) : undefined;

  const where: Record<string, unknown> = {};
  if (teamId) where.teamId = teamId;
  if (modelId) where.id = modelId;
  if (name) where.name = name;
  if (Number.isFinite(version)) where.version = version;

  console.log(`Starting model weight migration (${apply ? 'apply' : 'dry-run'})...`);

  const models = await prisma.trainedModel.findMany({
    where,
    select: {
      id: true,
      name: true,
      version: true,
      s3Path: true,
      s3Bucket: true,
      weightsFile: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  if (models.length === 0) {
    console.log('No models found for the given filters.');
    return;
  }

  let copied = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const model of models as ModelRow[]) {
    const parsed = parseS3Path(model.s3Path);
    if (!parsed?.keyPrefix) {
      console.warn(`[skip] ${model.id}: invalid s3Path ${model.s3Path}`);
      skipped += 1;
      continue;
    }

    const bucket = parsed.bucket || model.s3Bucket || S3Service.bucketName;
    if (model.s3Bucket && parsed.bucket && model.s3Bucket !== parsed.bucket) {
      console.warn(
        `[warn] ${model.id}: s3Bucket (${model.s3Bucket}) differs from s3Path bucket (${parsed.bucket}). Using ${parsed.bucket}.`
      );
    }

    const weightsFile = model.weightsFile || 'best.pt';
    const sourceKey = parsed.keyPrefix.endsWith('.pt')
      ? parsed.keyPrefix
      : `${parsed.keyPrefix.replace(/\/$/, '')}/${weightsFile}`;

    const canonicalPrefix = toCanonicalPrefix(model);
    const canonicalKey = `${canonicalPrefix}/${weightsFile}`;
    const canonicalS3Path = `s3://${bucket}/${canonicalPrefix}`;

    if (sourceKey === canonicalKey) {
      if (model.s3Path !== canonicalS3Path || model.s3Bucket !== bucket) {
        console.log(`[update] ${model.id}: normalize s3Path -> ${canonicalS3Path}`);
        if (apply) {
          await prisma.trainedModel.update({
            where: { id: model.id },
            data: { s3Path: canonicalS3Path, s3Bucket: bucket },
          });
        }
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    try {
      const sourceExists = await S3Service.objectExists(sourceKey, bucket);
      if (!sourceExists) {
        console.error(`[fail] ${model.id}: source not found s3://${bucket}/${sourceKey}`);
        failed += 1;
        continue;
      }

      const canonicalExists = await S3Service.objectExists(canonicalKey, bucket);
      if (!canonicalExists) {
        console.log(`[copy] ${model.id}: s3://${bucket}/${sourceKey} -> s3://${bucket}/${canonicalKey}`);
        if (apply) {
          await S3Service.copyObject(sourceKey, canonicalKey, bucket);
        }
        copied += 1;
      } else {
        console.log(`[skip] ${model.id}: canonical already exists s3://${bucket}/${canonicalKey}`);
        skipped += 1;
      }

      if (model.s3Path !== canonicalS3Path || model.s3Bucket !== bucket) {
        console.log(`[update] ${model.id}: normalize s3Path -> ${canonicalS3Path}`);
        if (apply) {
          await prisma.trainedModel.update({
            where: { id: model.id },
            data: { s3Path: canonicalS3Path, s3Bucket: bucket },
          });
        }
        updated += 1;
      }
    } catch (error) {
      console.error(
        `[fail] ${model.id}: ${error instanceof Error ? error.message : 'unknown error'}`
      );
      failed += 1;
    }
  }

  console.log('---');
  console.log(`Processed: ${models.length}`);
  console.log(`Copied:    ${copied}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Failed:    ${failed}`);
  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to make changes.');
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
