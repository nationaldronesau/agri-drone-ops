import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess, getUserTeamIds } from '@/lib/auth/api-auth';
import { checkRedisConnection } from '@/lib/queue/redis';
import { enqueuePineStocktakeStage } from '@/lib/queue/pine-stocktake-queue';
import { createPineStocktake } from '@/lib/services/pine-stocktake-jobs';

const missionFile = z.object({
  kind: z.enum(['IMAGE_LV', 'IMAGE_RV', 'CLC', 'CLI', 'MRK', 'RPOS', 'POSE_EQUIVALENT', 'LIDAR_LAS', 'LIDAR_LAZ', 'CAMERA_METADATA']),
  assetId: z.string().optional(),
  fileName: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  cameraSerial: z.string().optional(),
  poseIdentity: z.string().optional(),
  timebase: z.string().optional(),
  crs: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const createSchema = z.object({
  projectId: z.string().min(1),
  orthomosaicId: z.string().optional(),
  files: z.array(missionFile).min(1),
  latitude: z.number().min(-80).max(84),
  longitude: z.number().min(-180).max(180),
  poseTimebase: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid Pine Stocktake mission', issues: parsed.error.issues }, { status: 400 });
  const access = await checkProjectAccess(parsed.data.projectId);
  if (!access.authenticated) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess || !access.userId || !access.teamId) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  const assetIds = [...new Set(parsed.data.files.flatMap((file) => file.assetId ? [file.assetId] : []))];
  const projectAssetCount = await prisma.asset.count({ where: { id: { in: assetIds }, projectId: parsed.data.projectId } });
  if (projectAssetCount !== assetIds.length) return NextResponse.json({ error: 'One or more mission files are not project assets' }, { status: 400 });
  if (parsed.data.orthomosaicId) {
    const orthomosaic = await prisma.orthomosaic.findFirst({ where: { id: parsed.data.orthomosaicId, projectId: parsed.data.projectId }, select: { id: true } });
    if (!orthomosaic) return NextResponse.json({ error: 'Orthomosaic does not belong to the project' }, { status: 400 });
  }
  if (!(await checkRedisConnection())) return NextResponse.json({ error: 'Pine Stocktake queue is unavailable' }, { status: 503 });
  try {
    const job = await createPineStocktake({ ...parsed.data, teamId: access.teamId, createdById: access.userId });
    const idempotencyKey = job.immutableManifestSha256.slice(0, 16);
    await enqueuePineStocktakeStage({ stocktakeJobId: job.id, stage: 'validate_mission', idempotencyKey });
    return NextResponse.json({ jobId: job.id, status: job.status, stage: job.stage }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to create Pine Stocktake job' }, { status: 400 });
  }
}

export async function GET() {
  const auth = await getUserTeamIds();
  if (!auth.authenticated) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  const jobs = await prisma.pineStocktakeJob.findMany({
    where: { teamId: { in: auth.teamIds } },
    select: { id: true, projectId: true, orthomosaicId: true, status: true, stage: true, progress: true, counters: true, failureReason: true, createdAt: true, updatedAt: true, project: { select: { name: true } } },
    orderBy: { updatedAt: 'desc' }, take: 100,
  });
  return NextResponse.json({ jobs });
}
