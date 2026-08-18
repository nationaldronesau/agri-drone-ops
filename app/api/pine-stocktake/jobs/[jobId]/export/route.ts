import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';

type Params = { params: Promise<{ jobId: string }> };
const csv = (value: unknown) => {
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export async function GET(request: NextRequest, { params }: Params) {
  const { jobId } = await params;
  const job = await prisma.pineStocktakeJob.findUnique({ where: { id: jobId }, include: { acceptedCrowns: { include: { lidarAssociation: true } }, duplicateGroups: true } });
  if (!job) return NextResponse.json({ error: 'Pine Stocktake job not found' }, { status: 404 });
  const access = await checkProjectAccess(job.projectId);
  if (!access.authenticated) return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  if (!access.hasAccess) return NextResponse.json({ error: access.error ?? 'Access denied' }, { status: 403 });
  if (job.acceptedCrowns.some((crown) => !crown.lidarAssociation)) return NextResponse.json({ error: 'Mapping is incomplete: every accepted crown needs a LiDAR result or explicit missing reason' }, { status: 409 });
  const duplicateByCrown = new Map<string, typeof job.duplicateGroups[number]>();
  for (const group of job.duplicateGroups) for (const crownId of group.acceptedCrownIds as string[]) duplicateByCrown.set(crownId, group);
  const exportCrowns = job.acceptedCrowns.filter((crown) => { const group = duplicateByCrown.get(crown.crownId); return !group || group.canonicalCrownId === crown.crownId; });
  const rows = exportCrowns.map((crown) => {
    const duplicate = duplicateByCrown.get(crown.crownId);
    return { stock_id: duplicate?.canonicalCrownId ?? crown.crownId, crown_id: crown.crownId, duplicate_crown_ids: duplicate?.acceptedCrownIds ?? [crown.crownId], observation_lineage: duplicate?.observationLineage ?? crown.lidarAssociation!.observationLineage, source_asset_id: crown.sourceAssetId, source_image_sha256: crown.sourceImageSha256, native_polygon: crown.nativePolygon, agreement_level: crown.agreementLevel, contributing_exemplar_ids: crown.contributingExemplarIds, reviewer_id: crown.reviewerId, reviewed_at: crown.reviewedAt.toISOString(), revision_lineage: crown.revisionLineage, edge_clipped: crown.edgeClipped, lidar_x: crown.lidarAssociation!.x, lidar_y: crown.lidarAssociation!.y, apex_x: crown.lidarAssociation!.apexX, apex_y: crown.lidarAssociation!.apexY, apex_z: crown.lidarAssociation!.apexZ, height_p99_m: crown.lidarAssociation!.heightP99M, height_max_valid_m: crown.lidarAssociation!.heightMaxValidM, local_ground_z: crown.lidarAssociation!.localGroundZ, match_confidence: crown.lidarAssociation!.matchConfidence, missing_reason: crown.lidarAssociation!.missingReason };
  });
  const format = new URL(request.url).searchParams.get('format') ?? 'geojson';
  if (format === 'csv') {
    const fields = Object.keys(rows[0] ?? { crown_id: '' });
    const body = [fields.join(','), ...rows.map((row) => fields.map((field) => csv(row[field as keyof typeof row])).join(','))].join('\n') + '\n';
    return new NextResponse(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="pine-stocktake-${jobId}.csv"` } });
  }
  const geojson = { type: 'FeatureCollection', crs: { type: 'name', properties: { name: job.targetCrs ?? 'UNKNOWN' } }, features: rows.map((row) => ({ type: 'Feature', geometry: row.lidar_x != null && row.lidar_y != null ? { type: 'Point', coordinates: [row.lidar_x, row.lidar_y] } : null, properties: row })) };
  return NextResponse.json(geojson, { headers: { 'content-disposition': `attachment; filename="pine-stocktake-${jobId}.geojson"` } });
}
