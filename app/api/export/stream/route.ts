import { NextRequest, NextResponse } from 'next/server';
import JSZip from 'jszip';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import {
  polygonToCenterBox,
  rescaleToOriginalWithMeta,
  validateGeoParams,
  pixelToGeoWithDSM,
} from '@/lib/utils/georeferencing';
import { generateShapefileExport, type DetectionRecord, type AnnotationRecord } from '@/lib/services/shapefile';
import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';

const EXPORT_ITEM_LIMIT = 5000;

interface ExportManifest {
  exportedAt: string;
  format: 'shapefile' | 'csv' | 'kml';
  crs: 'EPSG:4326';
  totalItems: number;
  exportedCount: number;
  skippedCount: number;
  skippedItems: Array<{
    assetId: string;
    assetName: string;
    annotationId: string;
    reason: string;
  }>;
  warnings: string[];
}

function escapeCSV(field: unknown): string {
  const str = String(field ?? '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function escapeXML(str: unknown): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function parseCenterBox(value: unknown): CenterBox | null {
  if (!value) return null;
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (
    parsed &&
    typeof parsed === 'object' &&
    'x' in parsed &&
    'y' in parsed &&
    'width' in parsed &&
    'height' in parsed
  ) {
    const candidate = parsed as { x: unknown; y: unknown; width: unknown; height: unknown };
    if (
      typeof candidate.x !== 'number' ||
      typeof candidate.y !== 'number' ||
      typeof candidate.width !== 'number' ||
      typeof candidate.height !== 'number' ||
      !Number.isFinite(candidate.x) ||
      !Number.isFinite(candidate.y) ||
      !Number.isFinite(candidate.width) ||
      !Number.isFinite(candidate.height) ||
      candidate.width <= 0 ||
      candidate.height <= 0
    ) {
      return null;
    }
    return {
      x: candidate.x,
      y: candidate.y,
      width: candidate.width,
      height: candidate.height,
    };
  }

  if (Array.isArray(parsed) && parsed.length >= 4) {
    const [x1, y1, x2, y2] = parsed as number[];
    if (
      !Number.isFinite(x1) ||
      !Number.isFinite(y1) ||
      !Number.isFinite(x2) ||
      !Number.isFinite(y2)
    ) {
      return null;
    }
    const width = x2 - x1;
    const height = y2 - y1;
    if (width <= 0 || height <= 0) return null;
    return {
      x: x1 + width / 2,
      y: y1 + height / 2,
      width,
      height,
    };
  }

  return null;
}

function manualConfidenceToScore(confidence: string | null): number {
  if (confidence === 'CERTAIN') return 0.95;
  if (confidence === 'LIKELY') return 0.75;
  return 0.5;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (membership.dbError) {
      return NextResponse.json({ error: 'Database error' }, { status: 500 });
    }

    const searchParams = request.nextUrl.searchParams;
    const format = (searchParams.get('format') || 'csv') as 'csv' | 'kml' | 'shapefile';
    const projectId = searchParams.get('projectId');
    const sessionId = searchParams.get('sessionId');
    const includeAI = searchParams.get('includeAI') !== 'false';
    const includeManual = searchParams.get('includeManual') !== 'false';
    const classFilter = searchParams.get('classes')?.split(',').filter(Boolean) || [];
    // GEO_DEBUG=1 logs a single JSON payload per request; optional GEO_DEBUG_ASSET_ID/GEO_DEBUG_ITEM_ID filter it.
    const geoDebugEnabled = process.env.GEO_DEBUG === '1';
    const geoDebugAssetFilter = process.env.GEO_DEBUG_ASSET_ID;
    const geoDebugItemFilter = process.env.GEO_DEBUG_ITEM_ID;
    let geoDebugLogged = false;
    const logGeoDebugOnce = (payload: Record<string, unknown>) => {
      if (!geoDebugEnabled || geoDebugLogged) return;
      const assetId = payload.assetId;
      const itemId = payload.itemId;
      if (geoDebugAssetFilter && assetId !== geoDebugAssetFilter) return;
      if (geoDebugItemFilter && itemId !== geoDebugItemFilter) return;
      geoDebugLogged = true;
      console.log(JSON.stringify(payload));
    };

    if (!['csv', 'kml', 'shapefile'].includes(format)) {
      return NextResponse.json({ error: 'Invalid format. Use csv, kml, or shapefile.' }, { status: 400 });
    }

    const baseWhere: Record<string, unknown> = {
      asset: {
        project: {
          teamId: { in: membership.teamIds },
        },
      },
    };

    let assetIds: string[] | null = null;
    let createdAfter: Date | null = null;
    if (sessionId) {
      const session = await prisma.reviewSession.findUnique({
        where: { id: sessionId },
        select: { assetIds: true, teamId: true, createdAt: true },
      });
      if (!session) {
        return NextResponse.json({ error: 'Review session not found' }, { status: 404 });
      }
      if (!membership.teamIds.includes(session.teamId)) {
        return NextResponse.json({ error: 'Access denied' }, { status: 403 });
      }
      assetIds = Array.isArray(session.assetIds)
        ? (session.assetIds as string[]).filter((id) => typeof id === 'string')
        : [];
      createdAfter = session.createdAt;
      baseWhere.asset = {
        ...(baseWhere.asset as Record<string, unknown>),
        id: { in: assetIds },
      };
    }

    if (projectId && projectId !== 'all') {
      (baseWhere.asset as Record<string, unknown>).projectId = projectId;
    }

    const [detections, annotations] = await Promise.all([
      includeAI
        ? prisma.detection.findMany({
            where: {
              ...baseWhere,
              type: { in: ['AI', 'YOLO_LOCAL'] },
              rejected: false,
              OR: [{ verified: true }, { userCorrected: true }],
              ...(createdAfter ? { createdAt: { gte: createdAfter } } : {}),
              ...(classFilter.length > 0 ? { className: { in: classFilter } } : {}),
            },
            include: {
              asset: {
                select: {
                  id: true,
                  fileName: true,
                  gpsLatitude: true,
                  gpsLongitude: true,
                  altitude: true,
                  gimbalPitch: true,
                  gimbalRoll: true,
                  gimbalYaw: true,
                  imageWidth: true,
                  imageHeight: true,
                  metadata: true,
                  lrfDistance: true,
                  lrfTargetLat: true,
                  lrfTargetLon: true,
                  project: {
                    select: {
                      name: true,
                      location: true,
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      includeManual
        ? prisma.manualAnnotation.findMany({
            where: {
              verified: true,
              session: {
                asset: baseWhere.asset,
              },
              ...(createdAfter ? { createdAt: { gte: createdAfter } } : {}),
              ...(classFilter.length > 0 ? { weedType: { in: classFilter } } : {}),
            },
            include: {
              session: {
                select: {
                  asset: {
                    select: {
                      id: true,
                      fileName: true,
                      gpsLatitude: true,
                      gpsLongitude: true,
                      altitude: true,
                      gimbalPitch: true,
                      gimbalRoll: true,
                      gimbalYaw: true,
                      imageWidth: true,
                      imageHeight: true,
                      metadata: true,
                      lrfDistance: true,
                      lrfTargetLat: true,
                      lrfTargetLon: true,
                      project: {
                        select: {
                          name: true,
                          location: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const skippedItems: ExportManifest['skippedItems'] = [];
    const exportableDetections: DetectionRecord[] = [];
    const exportableAnnotations: AnnotationRecord[] = [];

    for (const detection of detections) {
      const asset = detection.asset;
      const validation = validateGeoParams(asset);
      if (!validation.valid) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: detection.id,
          reason: validation.warnings[0] || 'Missing EXIF data',
        });
        continue;
      }

      let centerBox = parseCenterBox(detection.boundingBox);
      const preRescaleBox = centerBox ? { ...centerBox } : null;
      let meta = detection.preprocessingMeta as YOLOPreprocessingMeta | null;
      if (meta && typeof meta === 'string') {
        try {
          meta = JSON.parse(meta) as YOLOPreprocessingMeta;
        } catch {
          meta = null;
        }
      }
      const didRescale = Boolean(centerBox && detection.type === 'YOLO_LOCAL' && meta);
      if (centerBox && detection.type === 'YOLO_LOCAL' && meta) {
        centerBox = rescaleToOriginalWithMeta(centerBox, meta);
      }

      if (!centerBox) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: detection.id,
          reason: 'Invalid bounding box',
        });
        continue;
      }

      logGeoDebugOnce({
        format,
        itemKind: 'detection',
        itemId: detection.id,
        assetId: asset.id,
        fileName: asset.fileName,
        pixel: { x: centerBox.x, y: centerBox.y },
        bboxPreRescale: preRescaleBox,
        bboxPostRescale: didRescale ? { ...centerBox } : null,
        imageWidth: asset.imageWidth,
        imageHeight: asset.imageHeight,
        gpsLatitude: asset.gpsLatitude,
        gpsLongitude: asset.gpsLongitude,
        altitude: asset.altitude,
        gimbalPitch: asset.gimbalPitch,
        gimbalRoll: asset.gimbalRoll,
        gimbalYaw: asset.gimbalYaw,
        geoMethod: 'pixelToGeoWithDSM',
      });
      const geo = await pixelToGeoWithDSM(asset, { x: centerBox.x, y: centerBox.y });
      if (!geo) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: detection.id,
          reason: 'Georeferencing failed',
        });
        continue;
      }

      exportableDetections.push({
        id: detection.id,
        className: detection.className,
        confidence: detection.confidence ?? 0,
        centerLat: geo.lat,
        centerLon: geo.lon,
        createdAt: detection.createdAt,
        asset: {
          fileName: asset.fileName,
          project: asset.project,
        },
      });
    }

    for (const annotation of annotations) {
      const asset = annotation.session.asset;
      const validation = validateGeoParams(asset);
      if (!validation.valid) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: annotation.id,
          reason: validation.warnings[0] || 'Missing EXIF data',
        });
        continue;
      }

      const polygon = Array.isArray(annotation.coordinates)
        ? (annotation.coordinates as number[][])
        : [];
      const centerBox = polygonToCenterBox(polygon);
      if (!centerBox) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: annotation.id,
          reason: 'Invalid polygon geometry',
        });
        continue;
      }

      logGeoDebugOnce({
        format,
        itemKind: 'annotation',
        itemId: annotation.id,
        assetId: asset.id,
        fileName: asset.fileName,
        pixel: { x: centerBox.x, y: centerBox.y },
        bboxPreRescale: { ...centerBox },
        bboxPostRescale: null,
        imageWidth: asset.imageWidth,
        imageHeight: asset.imageHeight,
        gpsLatitude: asset.gpsLatitude,
        gpsLongitude: asset.gpsLongitude,
        altitude: asset.altitude,
        gimbalPitch: asset.gimbalPitch,
        gimbalRoll: asset.gimbalRoll,
        gimbalYaw: asset.gimbalYaw,
        geoMethod: 'pixelToGeoWithDSM',
      });
      const geo = await pixelToGeoWithDSM(asset, { x: centerBox.x, y: centerBox.y });
      if (!geo) {
        skippedItems.push({
          assetId: asset.id,
          assetName: asset.fileName,
          annotationId: annotation.id,
          reason: 'Georeferencing failed',
        });
        continue;
      }

      exportableAnnotations.push({
        id: annotation.id,
        weedType: annotation.weedType,
        confidence: annotation.confidence,
        centerLat: geo.lat,
        centerLon: geo.lon,
        coordinates: annotation.coordinates,
        notes: annotation.notes,
        createdAt: annotation.createdAt,
        session: {
          asset: {
            fileName: asset.fileName,
            project: asset.project,
          },
        },
      });
    }

    const totalItems = detections.length + annotations.length;
    const exportedCount = exportableDetections.length + exportableAnnotations.length;

    if (exportedCount > EXPORT_ITEM_LIMIT) {
      return NextResponse.json(
        {
          error: 'Export limit exceeded',
          message: `Cannot export more than ${EXPORT_ITEM_LIMIT} items. You have ${exportedCount} exportable items (${skippedItems.length} already skipped due to missing EXIF). Please apply additional filters.`,
          exportableCount: exportedCount,
          skippedCount: skippedItems.length,
          limit: EXPORT_ITEM_LIMIT,
        },
        { status: 400 }
      );
    }

    if (exportedCount === 0) {
      return NextResponse.json(
        { error: 'No exportable records found for the selected filters' },
        { status: 400 }
      );
    }

    const manifest: ExportManifest = {
      exportedAt: new Date().toISOString(),
      format,
      crs: 'EPSG:4326',
      totalItems,
      exportedCount,
      skippedCount: skippedItems.length,
      skippedItems,
      warnings:
        skippedItems.length > 0
          ? [`${skippedItems.length} items skipped - see skippedItems for details`]
          : [],
    };

    const zip = new JSZip();

    if (format === 'csv') {
      const rows = [
        'ID,Type,Class,Latitude,Longitude,Confidence,Image,Project,Location,Date',
      ];

      for (const detection of exportableDetections) {
        rows.push(
          [
            escapeCSV(detection.id),
            'AI',
            escapeCSV(detection.className),
            detection.centerLat?.toFixed(8) || '',
            detection.centerLon?.toFixed(8) || '',
            `${((detection.confidence || 0) * 100).toFixed(1)}%`,
            escapeCSV(detection.asset.fileName),
            escapeCSV(detection.asset.project?.name || ''),
            escapeCSV(detection.asset.project?.location || ''),
            detection.createdAt.toISOString().split('T')[0],
          ].join(',')
        );
      }

      for (const annotation of exportableAnnotations) {
        rows.push(
          [
            escapeCSV(annotation.id),
            'Manual',
            escapeCSV(annotation.weedType),
            annotation.centerLat?.toFixed(8) || '',
            annotation.centerLon?.toFixed(8) || '',
            `${(manualConfidenceToScore(annotation.confidence) * 100).toFixed(1)}%`,
            escapeCSV(annotation.session.asset.fileName),
            escapeCSV(annotation.session.asset.project?.name || ''),
            escapeCSV(annotation.session.asset.project?.location || ''),
            annotation.createdAt.toISOString().split('T')[0],
          ].join(',')
        );
      }

      zip.file('export.csv', rows.join('\n'));
    } else if (format === 'kml') {
      const placemarks: string[] = [];

      for (const detection of exportableDetections) {
        placemarks.push(`    <Placemark>
      <name>${escapeXML(detection.className)} (AI)</name>
      <description>${escapeXML(`Confidence: ${((detection.confidence || 0) * 100).toFixed(1)}%\nImage: ${detection.asset.fileName}`)}</description>
      <Point>
        <coordinates>${detection.centerLon},${detection.centerLat},0</coordinates>
      </Point>
    </Placemark>`);
      }

      for (const annotation of exportableAnnotations) {
        placemarks.push(`    <Placemark>
      <name>${escapeXML(annotation.weedType)} (Manual)</name>
      <description>${escapeXML(`Confidence: ${(manualConfidenceToScore(annotation.confidence) * 100).toFixed(1)}%\nImage: ${annotation.session.asset.fileName}`)}</description>
      <Point>
        <coordinates>${annotation.centerLon},${annotation.centerLat},0</coordinates>
      </Point>
    </Placemark>`);
      }

      const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Weed Detections</name>
    <description>Exported from AgriDrone Ops</description>
${placemarks.join('\n')}
  </Document>
</kml>
`;

      zip.file('export.kml', kmlContent);
    } else {
      const { buffer } = await generateShapefileExport(
        exportableDetections,
        exportableAnnotations
      );

      const shapefileZip = await JSZip.loadAsync(buffer);
      const entries = Object.values(shapefileZip.files).filter((file) => !file.dir);

      for (const entry of entries) {
        const content = await entry.async('nodebuffer');
        const baseName = entry.name.split('/').pop() || entry.name;
        const renamed = baseName.replace(/^detections\./, 'export.');
        zip.file(renamed, content);
      }
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    const filename = `export-${format}-${sessionId || projectId || 'all'}.zip`;

    return new Response(zipBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    console.error('Export error:', error);
    return NextResponse.json(
      { error: 'Failed to generate export' },
      { status: 500 }
    );
  }
}
