/* eslint-disable no-console */
import prisma from '@/lib/db';

function getArgValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

type FeatureFlags = {
  datasetVersions?: boolean;
  [key: string]: unknown;
};

function normalizeFeatures(input: unknown): FeatureFlags {
  if (!input || typeof input !== 'object') return {};
  return { ...(input as Record<string, unknown>) } as FeatureFlags;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    console.log(
      [
        'Usage: npm run feature:dataset-versions -- [options]',
        '',
        'Options:',
        '  --project <id>   Enable for a single project',
        '  --team <id>      Enable for all projects in a team',
        '  --all            Enable for all projects',
        '  --disable        Disable instead of enable',
        '  --apply          Apply changes (default is dry-run)',
        '',
        'Examples:',
        '  npm run feature:dataset-versions -- --project proj_123 --apply',
        '  npm run feature:dataset-versions -- --team team_123 --apply',
        '  npm run feature:dataset-versions -- --all --apply',
      ].join('\n')
    );
    return;
  }

  const projectId = getArgValue(argv, '--project');
  const teamId = getArgValue(argv, '--team');
  const apply = hasFlag(argv, '--apply');
  const disable = hasFlag(argv, '--disable');
  const all = hasFlag(argv, '--all');

  if (!projectId && !teamId && !all) {
    console.error('Provide --project, --team, or --all. Use --help for details.');
    process.exitCode = 1;
    return;
  }

  const where: Record<string, unknown> = {};
  if (projectId) where.id = projectId;
  if (teamId) where.teamId = teamId;

  const projects = await prisma.project.findMany({
    where,
    select: {
      id: true,
      name: true,
      teamId: true,
      features: true,
    },
  });

  if (projects.length === 0) {
    console.log('No projects found for the given filters.');
    return;
  }

  const targetValue = !disable;
  let updated = 0;
  let skipped = 0;

  for (const project of projects) {
    const current = normalizeFeatures(project.features);
    if (current.datasetVersions === targetValue) {
      console.log(`[skip] ${project.id} (${project.name}) already datasetVersions=${targetValue}`);
      skipped += 1;
      continue;
    }

    const nextFeatures: FeatureFlags = { ...current, datasetVersions: targetValue };
    console.log(
      `[${apply ? 'apply' : 'plan'}] ${project.id} (${project.name}) datasetVersions -> ${targetValue}`
    );

    if (apply) {
      await prisma.project.update({
        where: { id: project.id },
        data: { features: nextFeatures },
      });
      updated += 1;
    }
  }

  console.log('---');
  console.log(`Processed: ${projects.length}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
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
