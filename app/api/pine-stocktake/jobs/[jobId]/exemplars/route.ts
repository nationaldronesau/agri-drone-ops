import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { validateNativePolygon } from '@/lib/pine-stocktake/core';
import { stableSha256 } from '@/lib/services/pine-stocktake-jobs';

type Params = { params: Promise<{ jobId: string }> };
const schema = z.object({
  sourceAssetId: z.string().min(1),
  sourceImageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  nativePolygon: z.array(z.tuple([z.number().nonnegative(), z.number().nonnegative()])).min(3),
  approved: z.literal(true),
});

export async function POST(request: Request, { params }: Params) {
  const { jobId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid exemplar', issues: parsed.error.issues }, { status: 400 });
  const job = await prisma.pineStocktakeJob.findUnique({ where: { id: jobId }, select: { projectId: true, missionFiles: { where: { kind: { in: ['IMAGE_LV', 'IMAGE_RV'] } }, select: { assetId: true } }, _count: { select: { exemplars: true } } } });
  if (!job) return NextResponse.json({ error: 'Pine Stocktake job not found' }, { status: 404 });
  const access = await checkProjectAccess(job.projectId);
  if (!access.authenticated || !access.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  if (job._count.exemplars >= 3) return NextResponse.json({ error: 'Pine Stocktake v1 permits exactly three exemplars' }, { status: 409 });
  if (job.missionFiles.some((file) => file.assetId === parsed.data.sourceAssetId)) return NextResponse.json({ error: 'Target mission images are forbidden as exemplar prompts' }, { status: 400 });
  const sourceAsset = await prisma.asset.findFirst({ where: { id: parsed.data.sourceAssetId, projectId: job.projectId }, select: { id: true, imageWidth: true, imageHeight: true } });
  if (!sourceAsset || !sourceAsset.imageWidth || !sourceAsset.imageHeight) return NextResponse.json({ error: 'Exemplar source must be a native project image with dimensions' }, { status: 400 });
  try {
    validateNativePolygon(parsed.data.nativePolygon, sourceAsset.imageWidth, sourceAsset.imageHeight);
    const exemplarSha256 = stableSha256({ sourceAssetId: sourceAsset.id, sourceImageSha256: parsed.data.sourceImageSha256, nativePolygon: parsed.data.nativePolygon });
    const exemplar = await prisma.pineExemplar.create({ data: {
      jobId, sourceAssetId: sourceAsset.id, sourceImageSha256: parsed.data.sourceImageSha256,
      nativePolygon: parsed.data.nativePolygon as Prisma.InputJsonValue, exemplarSha256,
      approved: true, approvedById: access.userId, approvedAt: new Date(),
    } });
    return NextResponse.json({ exemplar }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to approve exemplar' }, { status: 409 });
  }
}
