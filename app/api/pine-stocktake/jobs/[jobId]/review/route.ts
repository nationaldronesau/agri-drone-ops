import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';

type Params = { params: Promise<{ jobId: string }> };
const point = z.tuple([z.number().nonnegative(), z.number().nonnegative()]);
const schema = z.object({
  revisionId: z.string().min(1), candidateId: z.string().nullable(), parentRevisionId: z.string().nullable(),
  sourceAssetId: z.string().min(1), sourceImageSha256: z.string().regex(/^[a-f0-9]{64}$/), nativePolygon: z.array(point).min(3),
  action: z.enum(['adjust', 'delete', 'add_missed', 'mark_unsure', 'mark_edge_clipped', 'accept']),
  reviewState: z.enum(['working', 'accepted', 'rejected', 'unsure']), edgeClipped: z.boolean(), crownId: z.string().optional(),
});

export async function POST(request: Request, { params }: Params) {
  const { jobId } = await params;
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: 'Invalid review revision', issues: parsed.error.issues }, { status: 400 });
  const job = await prisma.pineStocktakeJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
  if (!job) return NextResponse.json({ error: 'Pine Stocktake job not found' }, { status: 404 });
  const access = await checkProjectAccess(job.projectId);
  if (!access.authenticated || !access.userId) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  const sourceAsset = await prisma.asset.findFirst({ where: { id: parsed.data.sourceAssetId, projectId: job.projectId }, select: { id: true } });
  if (!sourceAsset) return NextResponse.json({ error: 'Source image is not part of this project' }, { status: 400 });
  if (parsed.data.candidateId) {
    const candidate = await prisma.pineCandidate.findFirst({ where: { id: parsed.data.candidateId, jobId }, select: { id: true, targetAssetId: true, targetImageSha256: true } });
    if (!candidate || candidate.targetAssetId !== parsed.data.sourceAssetId || candidate.targetImageSha256 !== parsed.data.sourceImageSha256) return NextResponse.json({ error: 'Candidate identity mismatch' }, { status: 400 });
  }
  try {
    const result = await prisma.$transaction(async (tx) => {
      const lineage: string[] = [];
      let parentRevisionId = parsed.data.parentRevisionId;
      const visited = new Set<string>();
      while (parentRevisionId) {
        if (visited.has(parentRevisionId)) throw new Error('Review revision lineage contains a cycle');
        visited.add(parentRevisionId);
        const parent = await tx.pineReviewRevision.findUnique({ where: { id: parentRevisionId }, select: { id: true, jobId: true, parentRevisionId: true, candidateId: true } });
        if (!parent || parent.jobId !== jobId || parent.candidateId !== parsed.data.candidateId) throw new Error('Parent review revision identity mismatch');
        lineage.unshift(parent.id);
        parentRevisionId = parent.parentRevisionId;
      }
      const revision = await tx.pineReviewRevision.create({ data: { id: parsed.data.revisionId, jobId, candidateId: parsed.data.candidateId, parentRevisionId: parsed.data.parentRevisionId, reviewerId: access.userId!, nativePolygon: parsed.data.nativePolygon as Prisma.InputJsonValue, action: parsed.data.action, reviewState: parsed.data.reviewState, edgeClipped: parsed.data.edgeClipped } });
      if (parsed.data.action !== 'accept' || parsed.data.reviewState !== 'accepted') return { revision, acceptedCrown: null };
      if (!parsed.data.crownId) throw new Error('crownId is required when accepting a crown');
      const group = parsed.data.candidateId ? await tx.pineAgreementGroup.findFirst({ where: { jobId, members: { some: { candidateId: parsed.data.candidateId } } }, include: { members: { include: { candidate: true } } } }) : null;
      const acceptedCrown = await tx.pineAcceptedCrown.create({ data: {
        crownId: parsed.data.crownId, jobId, candidateId: parsed.data.candidateId, sourceAssetId: parsed.data.sourceAssetId,
        sourceImageSha256: parsed.data.sourceImageSha256, nativePolygon: parsed.data.nativePolygon as Prisma.InputJsonValue,
        contributingExemplarIds: (group?.members.map((member) => member.candidate.exemplarId) ?? []) as Prisma.InputJsonValue,
        scoresByExemplar: Object.fromEntries(group?.members.map((member) => [member.candidate.exemplarId, member.candidate.score]) ?? []) as Prisma.InputJsonValue,
        agreementLevel: group?.agreementLevel ?? 0, reviewerId: access.userId!, reviewedAt: new Date(), acceptedRevisionId: revision.id,
        revisionLineage: [...lineage, revision.id] as Prisma.InputJsonValue, edgeClipped: parsed.data.edgeClipped,
      } });
      return { revision, acceptedCrown };
    });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to save review revision' }, { status: 409 });
  }
}
