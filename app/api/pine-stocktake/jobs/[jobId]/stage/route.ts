import { NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { enqueuePineStocktakeStage } from '@/lib/queue/pine-stocktake-queue';

type Params = { params: Promise<{ jobId: string }> };
const schema = z.object({ stage: z.enum(['validate_mission', 'detect_exemplars', 'build_flat_map', 'map_lidar', 'export_results']), idempotencyKey: z.string().min(8).max(128) });

export async function POST(request: Request, { params }: Params) {
  const { jobId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid stage request' }, { status: 400 });
  const job = await prisma.pineStocktakeJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!job) return NextResponse.json({ error: 'Pine Stocktake job not found' }, { status: 404 });
  const access = await checkProjectAccess(job.projectId);
  if (!access.authenticated) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  const queueId = await enqueuePineStocktakeStage({ stocktakeJobId: jobId, ...parsed.data });
  return NextResponse.json({ queueId, status: 'queued' }, { status: 202 });
}
