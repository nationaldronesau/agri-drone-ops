/**
 * Compatibility surface for callers that historically imported the Matrice 4E
 * "precision" implementation. All projection math now lives in projection-core.
 */

import {
  getGeoidHeightCorrection,
  projectPixelToGeo,
  type ProjectionIntrinsics,
} from '@/lib/utils/projection-core';

type MetadataRecord = Record<string, unknown>;

const toNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const readNumber = (metadata: MetadataRecord, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = toNumber(metadata[key]);
    if (value != null) {
      return value;
    }
  }
  return undefined;
};

const readString = (metadata: MetadataRecord, keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
};

const META_KEYS = {
  imageWidth: ['ExifImageWidth', 'ImageWidth', 'imageWidth', 'PixelXDimension'],
  imageHeight: ['ExifImageHeight', 'ImageHeight', 'imageHeight', 'PixelYDimension'],
  calibratedFocalLength: ['CalibratedFocalLength', 'drone-dji:CalibratedFocalLength'],
  opticalCenterX: ['CalibratedOpticalCenterX', 'drone-dji:CalibratedOpticalCenterX'],
  opticalCenterY: ['CalibratedOpticalCenterY', 'drone-dji:CalibratedOpticalCenterY'],
  gpsLatitude: [
    'GpsLatitude',
    'GPSLatitude',
    'Latitude',
    'latitude',
    'drone-dji:GPSLatitude',
    'drone-dji:GpsLatitude',
  ],
  gpsLongitude: [
    'GpsLongitude',
    'GPSLongitude',
    'Longitude',
    'longitude',
    'drone-dji:GPSLongitude',
    'drone-dji:GpsLongitude',
  ],
  relativeAltitude: ['RelativeAltitude', 'drone-dji:RelativeAltitude'],
  absoluteAltitude: [
    'AbsoluteAltitude',
    'GPSAltitude',
    'altitude',
    'drone-dji:AbsoluteAltitude',
  ],
  gimbalPitch: ['GimbalPitchDegree', 'drone-dji:GimbalPitchDegree'],
  gimbalRoll: ['GimbalRollDegree', 'drone-dji:GimbalRollDegree'],
  gimbalYaw: [
    'GimbalYawDegree',
    'FlightYawDegree',
    'drone-dji:GimbalYawDegree',
    'drone-dji:FlightYawDegree',
  ],
  lrfDistance: ['LRFTargetDistance', 'drone-dji:LRFTargetDistance'],
  lrfLat: ['LRFTargetLat', 'drone-dji:LRFTargetLat'],
  lrfLon: ['LRFTargetLon', 'drone-dji:LRFTargetLon'],
  lrfAlt: ['LRFTargetAlt', 'drone-dji:LRFTargetAlt'],
  dewarpData: ['DewarpData', 'drone-dji:DewarpData'],
  fieldOfView: ['FieldOfView', 'drone-dji:FieldOfView', 'FOV', 'CameraFOV'],
};

export interface PrecisionMetadataStatus {
  hasCalibration: boolean;
  hasLRF: boolean;
  hasDewarp: boolean;
  calibratedFocalLength?: number;
  opticalCenterX?: number;
  opticalCenterY?: number;
}

export function getPrecisionMetadataStatus(metadata: MetadataRecord): PrecisionMetadataStatus {
  const calibratedFocalLength = readNumber(metadata, META_KEYS.calibratedFocalLength);
  const opticalCenterX = readNumber(metadata, META_KEYS.opticalCenterX);
  const opticalCenterY = readNumber(metadata, META_KEYS.opticalCenterY);
  const lrfDistance = readNumber(metadata, META_KEYS.lrfDistance);
  const lrfLat = readNumber(metadata, META_KEYS.lrfLat);
  const lrfLon = readNumber(metadata, META_KEYS.lrfLon);

  return {
    hasCalibration:
      calibratedFocalLength != null && opticalCenterX != null && opticalCenterY != null,
    hasLRF: lrfDistance != null && lrfDistance > 0 && lrfLat != null && lrfLon != null,
    hasDewarp: Boolean(readString(metadata, META_KEYS.dewarpData)),
    calibratedFocalLength,
    opticalCenterX,
    opticalCenterY,
  };
}

export function getCameraFovFromMetadata(metadata: MetadataRecord): number | null {
  return readNumber(metadata, META_KEYS.fieldOfView) ?? null;
}

export interface PrecisionGeoreferenceParams {
  imageWidth: number;
  imageHeight: number;
  calibratedFocalLength?: number;
  opticalCenterX?: number;
  opticalCenterY?: number;
  fieldOfView?: number;
  droneLatitude: number;
  droneLongitude: number;
  /** Legacy absolute-altitude field retained for API compatibility. */
  droneAltitude?: number;
  relativeAltitude?: number;
  absoluteAltitude?: number;
  gimbalPitch: number;
  gimbalRoll: number;
  gimbalYaw: number;
  lrfTargetDistance?: number;
  lrfTargetLatitude?: number;
  lrfTargetLongitude?: number;
  lrfTargetAltitude?: number;
  dewarpData?: string;
}

export interface PixelCoordinate {
  x: number;
  y: number;
}

export interface GeographicCoordinate {
  latitude: number;
  longitude: number;
  altitude?: number;
  method?: string;
  qualityFlags?: string[];
}

export async function precisionPixelToGeo(
  pixel: PixelCoordinate,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate | null> {
  const intrinsics: Partial<ProjectionIntrinsics> | undefined =
    params.calibratedFocalLength != null &&
    params.opticalCenterX != null &&
    params.opticalCenterY != null
      ? {
          f: params.calibratedFocalLength,
          cx: params.opticalCenterX,
          cy: params.opticalCenterY,
        }
      : undefined;

  const result = await projectPixelToGeo({
    pixel,
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    intrinsics,
    fieldOfViewDeg: params.fieldOfView,
    gimbalPitchDeg: params.gimbalPitch,
    gimbalRollDeg: params.gimbalRoll,
    gimbalYawDeg: params.gimbalYaw,
    droneLat: params.droneLatitude,
    droneLon: params.droneLongitude,
    lrfDistanceM: params.lrfTargetDistance,
    lrfTargetLat: params.lrfTargetLatitude,
    lrfTargetLon: params.lrfTargetLongitude,
    relativeAltitudeM: params.relativeAltitude,
    absoluteAltitudeM: params.absoluteAltitude ?? params.droneAltitude,
    lrfTargetElevationM: params.lrfTargetAltitude,
  });

  if (!result) {
    return null;
  }
  return {
    latitude: result.lat,
    longitude: result.lon,
    method: result.method,
    qualityFlags: result.qualityFlags,
  };
}

/**
 * Extract only metadata that is actually present. In particular, this never
 * injects Matrice 4E focal length or image-size defaults into other imagery.
 */
export function extractPrecisionParams(metadata: Record<string, unknown>): PrecisionGeoreferenceParams {
  const relativeAltitude = readNumber(metadata, META_KEYS.relativeAltitude);
  const absoluteAltitude = readNumber(metadata, META_KEYS.absoluteAltitude);
  return {
    imageWidth: readNumber(metadata, META_KEYS.imageWidth) ?? 0,
    imageHeight: readNumber(metadata, META_KEYS.imageHeight) ?? 0,
    calibratedFocalLength: readNumber(metadata, META_KEYS.calibratedFocalLength),
    opticalCenterX: readNumber(metadata, META_KEYS.opticalCenterX),
    opticalCenterY: readNumber(metadata, META_KEYS.opticalCenterY),
    fieldOfView: readNumber(metadata, META_KEYS.fieldOfView),
    droneLatitude: readNumber(metadata, META_KEYS.gpsLatitude) ?? 0,
    droneLongitude: readNumber(metadata, META_KEYS.gpsLongitude) ?? 0,
    droneAltitude: absoluteAltitude,
    relativeAltitude,
    absoluteAltitude,
    gimbalPitch: readNumber(metadata, META_KEYS.gimbalPitch) ?? -90,
    gimbalRoll: readNumber(metadata, META_KEYS.gimbalRoll) ?? 0,
    gimbalYaw: readNumber(metadata, META_KEYS.gimbalYaw) ?? 0,
    lrfTargetDistance: readNumber(metadata, META_KEYS.lrfDistance),
    lrfTargetLatitude: readNumber(metadata, META_KEYS.lrfLat),
    lrfTargetLongitude: readNumber(metadata, META_KEYS.lrfLon),
    lrfTargetAltitude: readNumber(metadata, META_KEYS.lrfAlt),
    dewarpData: readString(metadata, META_KEYS.dewarpData),
  };
}

export async function debugGeoreferencing(
  pixel: PixelCoordinate,
  metadata: Record<string, unknown>
): Promise<{
  oldMethod: GeographicCoordinate;
  newMethod: GeographicCoordinate | null;
  lrfReference: GeographicCoordinate | null;
  distanceError: number | null;
}> {
  const meta = metadata as Record<string, number | null | undefined>;
  const params = extractPrecisionParams(metadata);
  const oldResult = {
    latitude: (meta.latitude || 0) as number,
    longitude: (meta.longitude || 0) as number,
  };
  const newResult = await precisionPixelToGeo(pixel, params);
  const lrfReference =
    params.lrfTargetLatitude != null && params.lrfTargetLongitude != null
      ? {
          latitude: params.lrfTargetLatitude,
          longitude: params.lrfTargetLongitude,
          altitude: params.lrfTargetAltitude,
        }
      : null;

  let distanceError: number | null = null;
  if (newResult) {
    const latDiff = newResult.latitude - oldResult.latitude;
    const lonDiff = newResult.longitude - oldResult.longitude;
    distanceError = Math.hypot(latDiff, lonDiff) * 111111;
  }

  return { oldMethod: oldResult, newMethod: newResult, lrfReference, distanceError };
}

export { getGeoidHeightCorrection };
