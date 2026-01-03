/**
 * Shapefile Export Service
 *
 * Generates ESRI Shapefiles from detection and annotation data
 * for use with DJI spray drones and GIS software.
 */

import { zip } from '@mapbox/shp-write';
import type { Feature, FeatureCollection, Point } from 'geojson';

// WGS84 Projection file content (EPSG:4326)
// This is required for GIS software to correctly interpret coordinates
const WGS84_PRJ = `GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["Degree",0.017453292519943295]]`;

/**
 * Detection record from database
 */
export interface DetectionRecord {
  id: string;
  className: string;
  confidence: number | null;
  centerLat: number | null;
  centerLon: number | null;
  createdAt: Date;
  asset: {
    fileName: string;
    project?: {
      name: string;
      location: string | null;
    } | null;
  };
}

/**
 * Confidence level enum values from Prisma schema
 */
type ConfidenceLevel = 'CERTAIN' | 'LIKELY' | 'UNCERTAIN';

/**
 * Convert confidence level enum to numeric percentage
 * Maps string enum values to meaningful numeric confidence scores
 */
function confidenceLevelToNumber(level: ConfidenceLevel | string | null): number {
  switch (level) {
    case 'CERTAIN':
      return 100;
    case 'LIKELY':
      return 75;
    case 'UNCERTAIN':
      return 50;
    default:
      return 0;
  }
}

/**
 * Annotation record from database
 */
export interface AnnotationRecord {
  id: string;
  weedType: string;
  confidence: ConfidenceLevel | string | null;
  centerLat?: number | null;
  centerLon?: number | null;
  coordinates: unknown; // Pixel coordinates or coordinate object
  notes: string | null;
  createdAt: Date;
  session: {
    asset: {
      fileName: string;
      project?: {
        name: string;
        location: string | null;
      } | null;
    };
  };
}

/**
 * Properties stored in shapefile DBF
 * Field names limited to 10 characters for shapefile compatibility
 */
interface ShapefileProperties {
  ID: string;
  CLASS: string;
  CONFIDENCE: number;
  TYPE: string;
  ASSET: string;
  PROJECT: string;
  LOCATION: string;
  NOTES: string;
  CREATED: string;
}

/**
 * Validate coordinates are within valid geographic bounds
 * SAFETY CRITICAL: Invalid coordinates could misdirect spray drones
 */
export function isValidCoordinate(
  lat: number | null | undefined,
  lon: number | null | undefined
): boolean {
  if (lat == null || lon == null) return false;
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180
  );
}

/**
 * Truncate string to specified length for DBF compatibility
 */
function truncate(str: string | null | undefined, maxLength: number): string {
  const s = str ?? '';
  return s.length > maxLength ? s.substring(0, maxLength) : s;
}

/**
 * Format date as YYYY-MM-DD for shapefile
 */
function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Extract center coordinates from annotation
 * Annotations may have coordinates stored in different formats
 */
function getAnnotationCenter(annotation: AnnotationRecord): { lat: number | null; lon: number | null } {
  // First try the direct centerLat/centerLon fields
  if (annotation.centerLat != null && annotation.centerLon != null) {
    return { lat: annotation.centerLat, lon: annotation.centerLon };
  }

  // Try to extract from coordinates object
  const coords = annotation.coordinates as Record<string, unknown> | null;
  if (coords) {
    // Check for center property
    if (typeof coords === 'object' && 'center' in coords) {
      const center = coords.center as Record<string, unknown>;
      if (center && typeof center.lat === 'number' && typeof center.lon === 'number') {
        return { lat: center.lat, lon: center.lon };
      }
    }
    // Check for centerLat/centerLon in coords
    if ('centerLat' in coords && 'centerLon' in coords) {
      return {
        lat: coords.centerLat as number,
        lon: coords.centerLon as number
      };
    }
  }

  return { lat: null, lon: null };
}

/**
 * Transform detection records to GeoJSON features
 */
export function transformDetectionsToFeatures(
  detections: DetectionRecord[]
): Feature<Point, ShapefileProperties>[] {
  const features: Feature<Point, ShapefileProperties>[] = [];

  for (const detection of detections) {
    if (!isValidCoordinate(detection.centerLat, detection.centerLon)) {
      continue;
    }

    const feature: Feature<Point, ShapefileProperties> = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [detection.centerLon!, detection.centerLat!], // GeoJSON is [lon, lat]
      },
      properties: {
        ID: truncate(detection.id, 50),
        CLASS: truncate(detection.className, 50),
        CONFIDENCE: Math.round((detection.confidence ?? 0) * 100),
        TYPE: 'AI',
        ASSET: truncate(detection.asset.fileName, 100),
        PROJECT: truncate(detection.asset.project?.name ?? '', 50),
        LOCATION: truncate(detection.asset.project?.location ?? '', 100),
        NOTES: '',
        CREATED: formatDate(detection.createdAt),
      },
    };

    features.push(feature);
  }

  return features;
}

/**
 * Transform annotation records to GeoJSON features
 * Uses polygon centroid as point location
 */
export function transformAnnotationsToFeatures(
  annotations: AnnotationRecord[]
): Feature<Point, ShapefileProperties>[] {
  const features: Feature<Point, ShapefileProperties>[] = [];

  for (const annotation of annotations) {
    const { lat, lon } = getAnnotationCenter(annotation);

    if (!isValidCoordinate(lat, lon)) {
      continue;
    }

    const feature: Feature<Point, ShapefileProperties> = {
      type: 'Feature',
      geometry: {
        type: 'Point',
        coordinates: [lon!, lat!], // GeoJSON is [lon, lat]
      },
      properties: {
        ID: truncate(annotation.id, 50),
        CLASS: truncate(annotation.weedType, 50),
        CONFIDENCE: confidenceLevelToNumber(annotation.confidence),
        TYPE: 'Manual',
        ASSET: truncate(annotation.session.asset.fileName, 100),
        PROJECT: truncate(annotation.session.asset.project?.name ?? '', 50),
        LOCATION: truncate(annotation.session.asset.project?.location ?? '', 100),
        NOTES: truncate(annotation.notes, 254), // DBF string limit
        CREATED: formatDate(annotation.createdAt),
      },
    };

    features.push(feature);
  }

  return features;
}

/**
 * Generate shapefile ZIP buffer from GeoJSON features
 */
export async function generateShapefile(
  features: Feature<Point, ShapefileProperties>[]
): Promise<Buffer> {
  const featureCollection: FeatureCollection<Point, ShapefileProperties> = {
    type: 'FeatureCollection',
    features,
  };

  // Generate shapefile ZIP with WGS84 projection
  const zipBuffer = await zip<'nodebuffer'>(featureCollection, {
    folder: 'detections',
    filename: 'detections',
    prj: WGS84_PRJ,
    outputType: 'nodebuffer',
    compression: 'DEFLATE',
    types: {
      point: 'detections',
    },
  });

  return zipBuffer;
}

/**
 * Export statistics
 */
export interface ShapefileExportStats {
  totalDetections: number;
  totalAnnotations: number;
  exported: number;
  skippedInvalidCoords: number;
}

/**
 * Generate complete shapefile export from detections and annotations
 */
export async function generateShapefileExport(
  detections: DetectionRecord[],
  annotations: AnnotationRecord[]
): Promise<{ buffer: Buffer; stats: ShapefileExportStats }> {
  const stats: ShapefileExportStats = {
    totalDetections: detections.length,
    totalAnnotations: annotations.length,
    exported: 0,
    skippedInvalidCoords: 0,
  };

  // Transform to GeoJSON features
  const detectionFeatures = transformDetectionsToFeatures(detections);
  const annotationFeatures = transformAnnotationsToFeatures(annotations);

  // Combine all features
  const allFeatures = [...detectionFeatures, ...annotationFeatures];

  // Calculate stats
  stats.exported = allFeatures.length;
  stats.skippedInvalidCoords =
    (detections.length - detectionFeatures.length) +
    (annotations.length - annotationFeatures.length);

  // Generate shapefile
  const buffer = await generateShapefile(allFeatures);

  return { buffer, stats };
}
