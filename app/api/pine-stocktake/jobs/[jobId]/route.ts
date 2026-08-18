import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';

type Params = { params: Promise<{ jobId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const { jobId } = await params;
  const basic = await prisma.pineStocktakeJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!basic) return NextResponse.json({ error: 'Pine Stocktake job not found' }, { status: 404 });
  const access = await checkProjectAccess(basic.projectId);
  if (!access.authenticated) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  const job = await prisma.pineStocktakeJob.findUnique({
    where: { id: jobId },
    include: {
      project: { select: { id: true, name: true, location: true } },
      missionFiles: { select: { id: true, kind: true, assetId: true, fileName: true, sha256: true, cameraSerial: true, poseIdentity: true, timebase: true, crs: true } },
      exemplars: { select: { id: true, sourceAssetId: true, sourceImageSha256: true, nativePolygon: true, exemplarSha256: true, approved: true, sourceAsset: { select: { fileName: true, thumbnailUrl: true, storageUrl: true, imageWidth: true, imageHeight: true } } } },
      inferenceRuns: { select: { id: true, exemplarId: true, targetAssetId: true, status: true, attemptCount: true, failureReason: true } },
      agreementGroups: {
        include: {
          members: {
            include: {
              candidate: {
                include: {
                  targetAsset: { select: { id: true, fileName: true, storageUrl: true, thumbnailUrl: true, imageWidth: true, imageHeight: true } },
                },
              },
            },
          },
        },
        orderBy: [{ agreementLevel: 'desc' }, { agreementId: 'asc' }],
      },
      acceptedCrowns: { include: { lidarAssociation: true }, orderBy: { crownId: 'asc' } },
      flatMapResult: true,
    },
  });
  const reviewCounts = await prisma.pineReviewRevision.groupBy({ by: ['reviewState'], where: { jobId }, _count: { _all: true } });
  const candidateCount = await prisma.pineCandidate.count({ where: { jobId } });
  return NextResponse.json({
    job,
    summary: {
      candidate: candidateCount,
      accepted: job?.acceptedCrowns.length ?? 0,
      rejected: reviewCounts.find((row) => row.reviewState === 'rejected')?._count._all ?? 0,
      unsure: reviewCounts.find((row) => row.reviewState === 'unsure')?._count._all ?? 0,
      missedAdded: job?.acceptedCrowns.filter((crown) => crown.candidateId == null).length ?? 0,
      missingLidar: job?.acceptedCrowns.filter((crown) => crown.lidarAssociation?.status !== 'matched').length ?? 0,
    },
  });
}
