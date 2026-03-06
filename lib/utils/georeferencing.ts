import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';
import {
  precisionPixelToGeo,
  extractPrecisionParams,
  getPrecisionMetadataStatus,
  getCameraFovFromMetadata,
} from '@/lib/utils/precision-georeferencing';

export interface GeoreferenceParams {
  gpsLatitude: number;
  gpsLongitude: number;
  altitude: number;
  gimbalRoll: number;
  gimbalPitch: number;
  gimbalYaw: number;
  cameraFov: number;
  imageWidth: number;
  imageHeight: number;
  lrfDistance?: number;
  lrfTargetLat?: number;
  lrfTargetLon?: number;
  dtmData?: (lat: number, lon: number) => Promise<number>;
}

export interface PixelPoint {
  x: number;
  y: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface PixelCoordinates {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

export interface DronePosition {
  lat: number;
  lon: number;
  altitude: number;
  roll: number;
  pitch: number;
  yaw: number;
}

export interface CameraParams {
  fov: number;
}

export interface GeoCoordinates {
  lat: number;
  lon: number;
}

const METERS_PER_DEGREE_LAT = 111111;
const DEFAULT_MAX_LRF_OFFSET_M = 2000;
const DEFAULT_CAMERA_FOV = 84;
const DEFAULT_ALTITUDE = 100;
const MIN_IMAGE_DIMENSION_PX = 16;
const MIN_STANDARD_MAX_OFFSET_M = 250;
const STANDARD_MAX_FOOTPRINT_MULTIPLIER = 3;
const CAMERA_FOV_META_KEYS = ['FieldOfView', 'drone-dji:FieldOfView', 'FOV', 'CameraFOV'];
const CALIBRATED_FOCAL_META_KEYS = ['CalibratedFocalLength', 'drone-dji:CalibratedFocalLength'];
const FOCAL_LENGTH_35MM_META_KEYS = [
  'FocalLengthIn35mmFormat',
  'FocalLengthIn35mmFilm',
  'drone-dji:FocalLengthIn35mmFormat',
];
const RELATIVE_ALTITUDE_META_KEYS = ['RelativeAltitude', 'drone-dji:RelativeAltitude'];
const ABSOLUTE_ALTITUDE_META_KEYS = [
  'AbsoluteAltitude',
  'GPSAltitude',
  'altitude',
  'drone-dji:AbsoluteAltitude',
];
const IMAGE_WIDTH_META_KEYS = ['ExifImageWidth', 'ImageWidth', 'PixelXDimension', 'imageWidth'];
const IMAGE_HEIGHT_META_KEYS = ['ExifImageHeight', 'ImageHeight', 'PixelYDimension', 'imageHeight'];

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asMetadataRecord(metadata: unknown | null | undefined): Record<string, unknown> {
  return metadata && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>)
    : {};
}

function readMetadataNumber(metadata: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toFiniteNumber(metadata[key]);
    if (value != null) {
      return value;
    }
  }
  return null;
}

function readMaxMetadataNumber(metadata: Record<string, unknown>, keys: string[]): number | null {
  let maxValue: number | null = null;
  for (const key of keys) {
    const value = toFiniteNumber(metadata[key]);
    if (value != null && value > 0 && (maxValue == null || value > maxValue)) {
      maxValue = value;
    }
  }
  return maxValue;
}

function isValidFov(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 180;
}

function isPositiveFinite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveProjectionImageDimensions(
  imageWidth: number | null | undefined,
  imageHeight: number | null | undefined,
  metadata?: unknown | null
): { imageWidth: number | null; imageHeight: number | null } {
  const record = asMetadataRecord(metadata);
  const widthCandidates = [
    toFiniteNumber(imageWidth),
    readMaxMetadataNumber(record, IMAGE_WIDTH_META_KEYS),
  ].filter((value): value is number => value != null && value >= MIN_IMAGE_DIMENSION_PX);
  const heightCandidates = [
    toFiniteNumber(imageHeight),
    readMaxMetadataNumber(record, IMAGE_HEIGHT_META_KEYS),
  ].filter((value): value is number => value != null && value >= MIN_IMAGE_DIMENSION_PX);

  return {
    imageWidth: widthCandidates.length > 0 ? Math.max(...widthCandidates) : null,
    imageHeight: heightCandidates.length > 0 ? Math.max(...heightCandidates) : null,
  };
}

export function resolveProjectionAltitude(
  altitude: number | null | undefined,
  metadata?: unknown | null
): number | null {
  const record = asMetadataRecord(metadata);
  const relativeAltitude = readMetadataNumber(record, RELATIVE_ALTITUDE_META_KEYS);
  if (isPositiveFinite(relativeAltitude)) {
    return relativeAltitude;
  }

  if (isPositiveFinite(altitude)) {
    return altitude;
  }

  const absoluteAltitude = readMetadataNumber(record, ABSOLUTE_ALTITUDE_META_KEYS);
  if (isPositiveFinite(absoluteAltitude)) {
    return absoluteAltitude;
  }

  return null;
}

export function deriveHorizontalFovFromCalibration(
  imageWidth: number | null | undefined,
  calibratedFocalLength: number | null | undefined
): number | null {
  if (!isPositiveFinite(imageWidth) || !isPositiveFinite(calibratedFocalLength)) {
    return null;
  }
  const horizontalFovDeg =
    (2 * Math.atan((imageWidth / 2) / calibratedFocalLength) * 180) / Math.PI;
  return isValidFov(horizontalFovDeg) ? horizontalFovDeg : null;
}

export function deriveHorizontalFovFrom35mmEquivalent(
  focalLength35mm: number | null | undefined
): number | null {
  if (!isPositiveFinite(focalLength35mm)) {
    return null;
  }
  const horizontalFovDeg =
    (2 * Math.atan(36 / (2 * focalLength35mm)) * 180) / Math.PI;
  return isValidFov(horizontalFovDeg) ? horizontalFovDeg : null;
}

export function resolveProjectionCameraFov(
  cameraFov: number | null | undefined,
  imageWidth: number | null | undefined,
  metadata?: unknown | null,
  fallbackFov = DEFAULT_CAMERA_FOV
): number {
  const record = asMetadataRecord(metadata);
  const calibratedFocalLength = readMetadataNumber(record, CALIBRATED_FOCAL_META_KEYS);
  const derivedCalibrationFov = deriveHorizontalFovFromCalibration(imageWidth, calibratedFocalLength);
  const focalLength35mm = readMetadataNumber(record, FOCAL_LENGTH_35MM_META_KEYS);
  const derived35mmFov = deriveHorizontalFovFrom35mmEquivalent(focalLength35mm);
  const metadataFov = readMetadataNumber(record, CAMERA_FOV_META_KEYS);
  const parsedMetadataFov = isValidFov(metadataFov) ? metadataFov : null;
  const explicitFov = isValidFov(cameraFov) ? cameraFov : null;

  if (
    derivedCalibrationFov != null &&
    (explicitFov == null || Math.abs(explicitFov - fallbackFov) < 0.01)
  ) {
    return derivedCalibrationFov;
  }
  if (
    derived35mmFov != null &&
    (explicitFov == null || Math.abs(explicitFov - fallbackFov) < 0.01)
  ) {
    return derived35mmFov;
  }
  if (explicitFov != null) return explicitFov;
  if (derivedCalibrationFov != null) return derivedCalibrationFov;
  if (parsedMetadataFov != null) return parsedMetadataFov;

  const legacyFov = getCameraFovFromMetadata(record);
  if (legacyFov != null && isValidFov(legacyFov)) {
    return legacyFov;
  }
  if (derived35mmFov != null) return derived35mmFov;

  return fallbackFov;
}

export function normalizePixelPoint(
  pixel: PixelPoint,
  imageWidth: number,
  imageHeight: number
): PixelPoint {
  if (!isPositiveFinite(imageWidth) || !isPositiveFinite(imageHeight)) {
    throw new Error('Invalid image dimensions for pixel normalization');
  }
  const rawX = toFiniteNumber(pixel.x);
  const rawY = toFiniteNumber(pixel.y);
  if (rawX == null || rawY == null) {
    throw new Error('Invalid pixel coordinates');
  }

  // Some inference backends emit normalized [0..1] coordinates while others emit absolute pixels.
  // Treat both axes as normalized together to avoid misclassifying low absolute pixel values.
  const looksNormalized =
    rawX >= 0 && rawX <= 1 &&
    rawY >= 0 && rawY <= 1;
  const absoluteX = looksNormalized ? rawX * imageWidth : rawX;
  const absoluteY = looksNormalized ? rawY * imageHeight : rawY;

  return {
    x: Math.max(0, Math.min(imageWidth, absoluteX)),
    y: Math.max(0, Math.min(imageHeight, absoluteY)),
  };
}

function haversineDistanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const earthRadiusM = 6371000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusM * c;
}

function computeProjectionMaxOffsetMeters(
  altitude: number,
  cameraFov: number,
  imageWidth: number,
  imageHeight: number
): number {
  if (
    !isPositiveFinite(altitude) ||
    !isPositiveFinite(cameraFov) ||
    !isPositiveFinite(imageWidth) ||
    !isPositiveFinite(imageHeight)
  ) {
    return MIN_STANDARD_MAX_OFFSET_M;
  }

  const hFovRad = (cameraFov * Math.PI) / 180;
  const vFovRad = hFovRad * (imageHeight / imageWidth);
  const theoreticalMaxOffsetMeters =
    altitude *
    Math.hypot(
      Math.tan(hFovRad / 2),
      Math.tan(vFovRad / 2)
    );

  if (!Number.isFinite(theoreticalMaxOffsetMeters) || theoreticalMaxOffsetMeters <= 0) {
    return MIN_STANDARD_MAX_OFFSET_M;
  }

  return Math.max(
    MIN_STANDARD_MAX_OFFSET_M,
    theoreticalMaxOffsetMeters * STANDARD_MAX_FOOTPRINT_MULTIPLIER
  );
}

function capProjectedOffset(
  originLat: number,
  originLon: number,
  projectedLat: number,
  projectedLon: number,
  maxOffsetMeters: number
): { lat: number; lon: number; clipped: boolean } {
  const distanceMeters = haversineDistanceMeters(
    originLat,
    originLon,
    projectedLat,
    projectedLon
  );
  if (
    !Number.isFinite(distanceMeters) ||
    !Number.isFinite(maxOffsetMeters) ||
    distanceMeters <= maxOffsetMeters
  ) {
    return { lat: projectedLat, lon: projectedLon, clipped: false };
  }

  const scale = maxOffsetMeters / distanceMeters;
  return {
    lat: originLat + (projectedLat - originLat) * scale,
    lon: originLon + (projectedLon - originLon) * scale,
    clipped: true,
  };
}

type GeoFeaturePolygon = {
  type: 'Feature';
  geometry: {
    type: 'Polygon';
    coordinates: Array<Array<[number, number]>>;
  };
  properties: Record<string, unknown>;
};

export interface GeoValidationResult {
  valid: boolean;
  error?: string;
}

export interface GeoParamsValidationResult {
  valid: boolean;
  missingFields: string[];
  warnings: string[];
}

export interface GeoAssetParams {
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  cameraFov?: number | null;
  metadata?: unknown | null;
  lrfDistance?: number | null;
  lrfTargetLat?: number | null;
  lrfTargetLon?: number | null;
}

/**
 * SAFETY CRITICAL: Validates computed GPS coordinates for spray drone operations.
 * Invalid coordinates could send drones to wrong locations.
 *
 * Returns a validation result instead of throwing to allow graceful handling
 * in batch processing pipelines (e.g., skip invalid detections without aborting).
 *
 * @returns GeoValidationResult with valid flag and optional error message
 */
export function validateGeoCoordinates(lat: number, lon: number, context: string = 'computed'): GeoValidationResult {
  // Check for NaN or Infinity (can occur from division by near-zero)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return {
      valid: false,
      error: `[SAFETY] ${context} coordinates are invalid: lat=${lat}, lon=${lon}. ` +
        `This may indicate extreme gimbal angles or invalid altitude values.`
    };
  }

  // Validate geographic ranges
  if (lat < -90 || lat > 90) {
    return {
      valid: false,
      error: `[SAFETY] ${context} latitude out of range: ${lat}. Valid range is -90 to 90.`
    };
  }

  if (lon < -180 || lon > 180) {
    return {
      valid: false,
      error: `[SAFETY] ${context} longitude out of range: ${lon}. Valid range is -180 to 180.`
    };
  }

  return { valid: true };
}

/**
 * SAFETY CRITICAL: Validates coordinates and throws if invalid.
 * Use this when you want to halt processing on invalid coordinates.
 *
 * @throws Error if coordinates are invalid
 */
export function assertValidGeoCoordinates(lat: number, lon: number, context: string = 'computed'): void {
  const result = validateGeoCoordinates(lat, lon, context);
  if (!result.valid) {
    throw new Error(result.error);
  }
}

export function validateGeoParams(asset: GeoAssetParams): GeoParamsValidationResult {
  const missing: string[] = [];
  if (asset.gpsLatitude == null) missing.push('gpsLatitude');
  if (asset.gpsLongitude == null) missing.push('gpsLongitude');
  if (asset.gimbalPitch == null) missing.push('gimbalPitch');
  if (asset.gimbalRoll == null) missing.push('gimbalRoll');
  if (asset.gimbalYaw == null) missing.push('gimbalYaw');

  const resolvedAltitude = resolveProjectionAltitude(asset.altitude, asset.metadata);
  if (resolvedAltitude == null) {
    missing.push('altitude');
  }

  const resolvedDimensions = resolveProjectionImageDimensions(
    asset.imageWidth,
    asset.imageHeight,
    asset.metadata
  );
  if (resolvedDimensions.imageWidth == null) {
    missing.push('imageWidth');
  }
  if (resolvedDimensions.imageHeight == null) {
    missing.push('imageHeight');
  }

  return {
    valid: missing.length === 0,
    missingFields: missing,
    warnings: missing.length > 0 ? [`Missing EXIF: ${missing.join(', ')}`] : [],
  };
}

export type GeoResolutionMethod = 'precision_dsm' | 'precision_lrf_dsm' | 'standard';

export interface GeoResolution {
  geo: GeoPoint;
  method: GeoResolutionMethod;
}

export async function resolveGeoCoordinates(
  asset: GeoAssetParams,
  pixel: PixelPoint
): Promise<GeoResolution | null> {
  if (asset.gpsLatitude == null || asset.gpsLongitude == null) {
    return null;
  }

  const metadata =
    asset.metadata && typeof asset.metadata === 'object'
      ? (asset.metadata as Record<string, unknown>)
      : {};
  const resolvedDimensions = resolveProjectionImageDimensions(
    asset.imageWidth,
    asset.imageHeight,
    metadata
  );
  if (resolvedDimensions.imageWidth == null || resolvedDimensions.imageHeight == null) {
    return null;
  }
  const projectionAltitude = resolveProjectionAltitude(asset.altitude, metadata);
  let normalizedPixel: PixelPoint;
  try {
    normalizedPixel = normalizePixelPoint(
      pixel,
      resolvedDimensions.imageWidth,
      resolvedDimensions.imageHeight
    );
  } catch {
    return null;
  }

  const precisionStatus = getPrecisionMetadataStatus(metadata);
  const shouldUsePrecision = precisionStatus.hasCalibration || precisionStatus.hasLRF;

  if (shouldUsePrecision) {
    const precision = await pixelToGeoWithDSM(
      {
        ...asset,
        altitude: projectionAltitude,
        imageWidth: resolvedDimensions.imageWidth,
        imageHeight: resolvedDimensions.imageHeight,
      },
      normalizedPixel
    );
    if (precision) {
      return {
        geo: precision,
        method: precisionStatus.hasLRF ? 'precision_lrf_dsm' : 'precision_dsm',
      };
    }
  }

  const cameraFov = resolveProjectionCameraFov(
    asset.cameraFov,
    resolvedDimensions.imageWidth,
    metadata,
    DEFAULT_CAMERA_FOV
  );

  const geoParams: GeoreferenceParams = {
    gpsLatitude: asset.gpsLatitude,
    gpsLongitude: asset.gpsLongitude,
    altitude: projectionAltitude ?? DEFAULT_ALTITUDE,
    gimbalRoll: asset.gimbalRoll ?? 0,
    gimbalPitch: asset.gimbalPitch ?? 0,
    gimbalYaw: asset.gimbalYaw ?? 0,
    cameraFov,
    imageWidth: resolvedDimensions.imageWidth,
    imageHeight: resolvedDimensions.imageHeight,
    lrfDistance: asset.lrfDistance ?? undefined,
    lrfTargetLat: asset.lrfTargetLat ?? undefined,
    lrfTargetLon: asset.lrfTargetLon ?? undefined,
  };

  try {
    const geoResult = pixelToGeo(geoParams, normalizedPixel);
    const geo = geoResult instanceof Promise ? await geoResult : geoResult;
    return { geo, method: 'standard' };
  } catch {
    return null;
  }
}

export function pixelToGeo(
  params: GeoreferenceParams,
  pixel: PixelPoint,
  useLrf: boolean = true
): GeoPoint | Promise<GeoPoint> {
  // Input validation
  if (!params || !pixel) {
    throw new Error('Invalid parameters');
  }
  if (!isPositiveFinite(params.imageWidth) || !isPositiveFinite(params.imageHeight)) {
    throw new Error('Invalid image dimensions');
  }
  const normalizedPixel = normalizePixelPoint(pixel, params.imageWidth, params.imageHeight);

  const metersPerLat = METERS_PER_DEGREE_LAT; // approximately
  const metersPerLon = METERS_PER_DEGREE_LAT * Math.cos(params.gpsLatitude * Math.PI / 180);

  const hasLrfTarget =
    typeof params.lrfTargetLat === 'number' &&
    typeof params.lrfTargetLon === 'number' &&
    Number.isFinite(params.lrfTargetLat) &&
    Number.isFinite(params.lrfTargetLon);
  const hasLrfDistance =
    typeof params.lrfDistance === 'number' &&
    Number.isFinite(params.lrfDistance) &&
    params.lrfDistance > 0;

  let lrfLooksPlausible = false;
  if (useLrf && hasLrfTarget && hasLrfDistance) {
    const lrfTargetLat = params.lrfTargetLat as number;
    const lrfTargetLon = params.lrfTargetLon as number;
    const lrfDistance = params.lrfDistance as number;
    const gpsToLrfMeters = haversineDistanceMeters(
      params.gpsLatitude,
      params.gpsLongitude,
      lrfTargetLat,
      lrfTargetLon
    );
    const maxExpectedOffset = Math.max(
      DEFAULT_MAX_LRF_OFFSET_M,
      lrfDistance * 8 + 500
    );
    lrfLooksPlausible = Number.isFinite(gpsToLrfMeters) && gpsToLrfMeters <= maxExpectedOffset;
    if (!lrfLooksPlausible) {
      console.warn(
        `[GEO] Ignoring implausible LRF target offset (${gpsToLrfMeters.toFixed(1)}m > ${maxExpectedOffset.toFixed(1)}m)`
      );
    }
  }

  if (lrfLooksPlausible && params.lrfTargetLat !== undefined && params.lrfTargetLon !== undefined && params.lrfDistance !== undefined) {
    // Off-center LRF targeting and projection
    const normalizedX = (normalizedPixel.x / params.imageWidth) - 0.5;
    const normalizedY = (normalizedPixel.y / params.imageHeight) - 0.5;
    
    // Calculate offset based on camera FOV and normalized coordinates
    const hFov = params.cameraFov * Math.PI / 180;
    const vFov = hFov * params.imageHeight / params.imageWidth;
    
    const angleX = normalizedX * hFov;
    const angleY = normalizedY * vFov;
    
    // Apply camera-frame offsets from the LRF target point
    const distance = params.lrfDistance;
    const offsetEast = distance * Math.tan(angleX);
    // Image Y increases downward, so northing offset is inverted.
    const offsetNorth = -distance * Math.tan(angleY);

    const yaw = params.gimbalYaw * Math.PI / 180;
    const rotatedEast = offsetEast * Math.cos(yaw) - offsetNorth * Math.sin(yaw);
    const rotatedNorth = offsetEast * Math.sin(yaw) + offsetNorth * Math.cos(yaw);

    const metersPerLonAtTarget =
      111111 * Math.cos(params.lrfTargetLat * Math.PI / 180);
    if (!Number.isFinite(metersPerLonAtTarget) || Math.abs(metersPerLonAtTarget) < 1e-6) {
      throw new Error('Invalid longitude scale for LRF georeferencing');
    }

    const resultLat = params.lrfTargetLat + rotatedNorth / metersPerLat;
    const resultLon = params.lrfTargetLon + rotatedEast / metersPerLonAtTarget;

    // SAFETY: Validate before returning (throws on invalid)
    assertValidGeoCoordinates(resultLat, resultLon, 'LRF-based');

    return { lat: resultLat, lon: resultLon };
  }

  // Standard method without LRF
  const normalizedX = (normalizedPixel.x / params.imageWidth) - 0.5;
  const normalizedY = (normalizedPixel.y / params.imageHeight) - 0.5;
  
  // Calculate field of view angles
  const hFov = params.cameraFov * Math.PI / 180;
  const vFov = hFov * params.imageHeight / params.imageWidth;
  
  // Calculate ray angles
  const rayAngleX = normalizedX * hFov;
  const rayAngleY = normalizedY * vFov;
  
  // Apply gimbal rotations (simplified)
  const pitch = params.gimbalPitch * Math.PI / 180;
  const yaw = params.gimbalYaw * Math.PI / 180;

  const pitchPlusRay = pitch + rayAngleY;
  const pitchCos = Math.cos(pitchPlusRay);
  let rotatedOffsetX: number;
  let rotatedOffsetY: number;

  // Near-nadir pitch can make cos(pitch + rayAngleY) approach zero and explode offsets.
  if (!Number.isFinite(pitchCos) || Math.abs(pitchCos) < 0.15) {
    const stableOffsetEast = params.altitude * Math.tan(rayAngleX);
    const stableOffsetNorth = -params.altitude * Math.tan(rayAngleY);
    if (!Number.isFinite(stableOffsetEast) || !Number.isFinite(stableOffsetNorth)) {
      throw new Error('Projection became unstable for current pixel and camera angles');
    }
    rotatedOffsetX = stableOffsetEast * Math.cos(yaw) - stableOffsetNorth * Math.sin(yaw);
    rotatedOffsetY = stableOffsetEast * Math.sin(yaw) + stableOffsetNorth * Math.cos(yaw);
  } else {
    // Calculate ground distance
    const groundDistance = params.altitude / pitchCos;
    if (!Number.isFinite(groundDistance)) {
      throw new Error('Invalid ground distance computed from camera pitch');
    }

    // Calculate offsets
    const offsetX = groundDistance * Math.tan(rayAngleX);
    const offsetY = groundDistance * Math.sin(pitchPlusRay);

    // Rotate by yaw
    const bearingRad = yaw;
    rotatedOffsetX = offsetX * Math.sin(bearingRad) + offsetY * Math.cos(bearingRad);
    rotatedOffsetY = offsetX * Math.cos(bearingRad) - offsetY * Math.sin(bearingRad);
  }
  
  // Convert to lat/lon
  const latOffset = rotatedOffsetY / metersPerLat;
  const lonOffset = rotatedOffsetX / metersPerLon;
  
  const finalLatRaw = params.gpsLatitude + latOffset;
  const finalLonRaw = params.gpsLongitude + lonOffset;
  const maxOffsetMeters = computeProjectionMaxOffsetMeters(
    params.altitude,
    params.cameraFov,
    params.imageWidth,
    params.imageHeight
  );
  const cappedStandard = capProjectedOffset(
    params.gpsLatitude,
    params.gpsLongitude,
    finalLatRaw,
    finalLonRaw,
    maxOffsetMeters
  );
  const finalLat = cappedStandard.lat;
  const finalLon = cappedStandard.lon;
  if (cappedStandard.clipped) {
    console.warn(
      `[GEO] Clipped standard projection offset to ${maxOffsetMeters.toFixed(1)}m guardrail`
    );
  }

  // If DTM data is available, refine with terrain height
  if (params.dtmData) {
    return params.dtmData(finalLat, finalLon).then(terrainHeight => {
      const adjustedAltitude = params.altitude - terrainHeight;
      const adjustedPitchCos = Math.cos(pitchPlusRay);
      if (!Number.isFinite(adjustedPitchCos) || Math.abs(adjustedPitchCos) < 1e-6) {
        return { lat: finalLat, lon: finalLon };
      }
      const adjustedDistance = adjustedAltitude / adjustedPitchCos;
      if (!Number.isFinite(adjustedDistance)) {
        return { lat: finalLat, lon: finalLon };
      }
      const adjustedOffsetX = adjustedDistance * Math.tan(rayAngleX);
      const adjustedOffsetY = adjustedDistance * Math.sin(pitchPlusRay);

      const adjustedRotatedX = adjustedOffsetX * Math.sin(yaw) + adjustedOffsetY * Math.cos(yaw);
      const adjustedRotatedY = adjustedOffsetX * Math.cos(yaw) - adjustedOffsetY * Math.sin(yaw);

      const dtmLatRaw = params.gpsLatitude + adjustedRotatedY / metersPerLat;
      const dtmLonRaw = params.gpsLongitude + adjustedRotatedX / metersPerLon;
      const cappedDtm = capProjectedOffset(
        params.gpsLatitude,
        params.gpsLongitude,
        dtmLatRaw,
        dtmLonRaw,
        maxOffsetMeters
      );

      // SAFETY: Validate DTM-adjusted coordinates before returning (throws on invalid)
      assertValidGeoCoordinates(cappedDtm.lat, cappedDtm.lon, 'DTM-adjusted');

      return { lat: cappedDtm.lat, lon: cappedDtm.lon };
    });
  }

  // SAFETY: Validate standard coordinates before returning (throws on invalid)
  assertValidGeoCoordinates(finalLat, finalLon, 'standard');

  return { lat: finalLat, lon: finalLon };
}

// Simplified version for client-side use without DTM
export function pixelToGeoSimple(
  pixel: PixelCoordinates,
  imageWidth: number,
  imageHeight: number,
  dronePosition: DronePosition,
  cameraParams: CameraParams
): GeoCoordinates {
  const normalizedPixel = normalizePixelPoint(
    { x: pixel.x, y: pixel.y },
    imageWidth,
    imageHeight
  );
  const normalizedX = (normalizedPixel.x / imageWidth) - 0.5;
  const normalizedY = (normalizedPixel.y / imageHeight) - 0.5;
  
  const hFov = cameraParams.fov * Math.PI / 180;
  const vFov = hFov * imageHeight / imageWidth;
  
  const angleX = normalizedX * hFov;
  const angleY = normalizedY * vFov;
  
  const pitch = dronePosition.pitch * Math.PI / 180;
  const yaw = dronePosition.yaw * Math.PI / 180;
  
  const groundDistance = dronePosition.altitude / Math.cos(pitch + angleY);
  const offsetX = groundDistance * Math.tan(angleX);
  const offsetY = groundDistance * Math.sin(pitch + angleY);
  
  const bearingRad = yaw;
  const rotatedOffsetX = offsetX * Math.sin(bearingRad) + offsetY * Math.cos(bearingRad);
  const rotatedOffsetY = offsetX * Math.cos(bearingRad) - offsetY * Math.sin(bearingRad);
  
  const metersPerDegreeLat = 111111;
  const metersPerDegreeLon = 111111 * Math.cos(dronePosition.lat * Math.PI / 180);
  
  const latOffset = rotatedOffsetY / metersPerDegreeLat;
  const lonOffset = rotatedOffsetX / metersPerDegreeLon;

  const resultLat = dronePosition.lat + latOffset;
  const resultLon = dronePosition.lon + lonOffset;

  // SAFETY: Validate coordinates before returning (throws on invalid)
  assertValidGeoCoordinates(resultLat, resultLon, 'simplified');

  return { lat: resultLat, lon: resultLon };
}

export function boundingBoxToGeoPolygon(
  bbox: PixelCoordinates,
  imageWidth: number,
  imageHeight: number,
  dronePosition: DronePosition,
  cameraParams: CameraParams
): GeoFeaturePolygon {
  if (!bbox.width || !bbox.height) {
    throw new Error('Bounding box must have width and height properties');
  }

  const topLeft = pixelToGeoSimple(
    { x: bbox.x, y: bbox.y },
    imageWidth,
    imageHeight,
    dronePosition,
    cameraParams
  );
  
  const topRight = pixelToGeoSimple(
    { x: bbox.x + bbox.width, y: bbox.y },
    imageWidth,
    imageHeight,
    dronePosition,
    cameraParams
  );
  
  const bottomRight = pixelToGeoSimple(
    { x: bbox.x + bbox.width, y: bbox.y + bbox.height },
    imageWidth,
    imageHeight,
    dronePosition,
    cameraParams
  );
  
  const bottomLeft = pixelToGeoSimple(
    { x: bbox.x, y: bbox.y + bbox.height },
    imageWidth,
    imageHeight,
    dronePosition,
    cameraParams
  );

  return {
    type: 'Feature',
    geometry: {
      type: 'Polygon',
      coordinates: [[
        [topLeft.lon, topLeft.lat],
        [topRight.lon, topRight.lat],
        [bottomRight.lon, bottomRight.lat],
        [bottomLeft.lon, bottomLeft.lat],
        [topLeft.lon, topLeft.lat]
      ]]
    },
    properties: {}
  };
}

export function extractGeoParams(metadata: Record<string, unknown>): GeoreferenceParams {
  const meta = metadata as Record<string, number | null | undefined>;
  return {
    gpsLatitude: meta.GPSLatitude as number,
    gpsLongitude: meta.GPSLongitude as number,
    altitude: (meta.RelativeAltitude || meta.GPSAltitude || 0) as number,
    gimbalRoll: (meta.GimbalRollDegree || 0) as number,
    gimbalPitch: (meta.GimbalPitchDegree || -90) as number,
    gimbalYaw: (meta.GimbalYawDegree || meta.FlightYawDegree || 0) as number,
    cameraFov: (meta.FieldOfView || 84) as number,
    imageWidth: (meta.ImageWidth || meta.ExifImageWidth) as number,
    imageHeight: (meta.ImageHeight || meta.ExifImageHeight) as number,
    lrfDistance: (meta.LRFDistance ?? undefined) as number | undefined,
    lrfTargetLat: (meta.LRFTargetLat ?? undefined) as number | undefined,
    lrfTargetLon: (meta.LRFTargetLon ?? undefined) as number | undefined
  };
}

export function centerBoxToCorner(bbox: CenterBox): [number, number, number, number] {
  return [
    bbox.x - bbox.width / 2,
    bbox.y - bbox.height / 2,
    bbox.x + bbox.width / 2,
    bbox.y + bbox.height / 2,
  ];
}

export function polygonToCenterBox(points: number[][]): CenterBox | null {
  if (!Array.isArray(points) || points.length < 2) {
    return null;
  }

  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const width = maxX - minX;
  const height = maxY - minY;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    x: minX + width / 2,
    y: minY + height / 2,
    width,
    height,
  };
}

export function rescaleToOriginalWithMeta(
  bbox: CenterBox,
  meta: YOLOPreprocessingMeta
): CenterBox {
  let { x, y, width, height } = bbox;

  if (meta.letterbox?.enabled) {
    x = (x - meta.letterbox.padLeft) / meta.letterbox.scale;
    y = (y - meta.letterbox.padTop) / meta.letterbox.scale;
    width = width / meta.letterbox.scale;
    height = height / meta.letterbox.scale;
  } else {
    const scaleX = meta.originalWidth / meta.inferenceWidth;
    const scaleY = meta.originalHeight / meta.inferenceHeight;
    x *= scaleX;
    y *= scaleY;
    width *= scaleX;
    height *= scaleY;
  }

  if (meta.tiling?.enabled) {
    x += meta.tiling.tileX;
    y += meta.tiling.tileY;
  }

  return { x, y, width, height };
}

export async function pixelToGeoWithDSM(
  asset: GeoAssetParams,
  pixel: PixelPoint
): Promise<GeoPoint | null> {
  const validation = validateGeoParams(asset);
  if (!validation.valid) {
    return null;
  }

  const metadata =
    asset.metadata && typeof asset.metadata === 'object'
      ? (asset.metadata as Record<string, unknown>)
      : {};
  const resolvedDimensions = resolveProjectionImageDimensions(
    asset.imageWidth,
    asset.imageHeight,
    metadata
  );
  const resolvedAltitude = resolveProjectionAltitude(asset.altitude, metadata);
  if (
    resolvedDimensions.imageWidth == null ||
    resolvedDimensions.imageHeight == null ||
    resolvedAltitude == null
  ) {
    return null;
  }
  const normalizedPixel = normalizePixelPoint(
    pixel,
    resolvedDimensions.imageWidth,
    resolvedDimensions.imageHeight
  );
  const precisionStatus = getPrecisionMetadataStatus(metadata);

  // Avoid Matrice-specific defaults when calibration/LRF metadata is absent.
  if (!precisionStatus.hasCalibration && !precisionStatus.hasLRF) {
    try {
      const standardResult = pixelToGeo(
        {
          gpsLatitude: asset.gpsLatitude!,
          gpsLongitude: asset.gpsLongitude!,
          altitude: resolvedAltitude,
          gimbalPitch: asset.gimbalPitch ?? 0,
          gimbalRoll: asset.gimbalRoll ?? 0,
          gimbalYaw: asset.gimbalYaw ?? 0,
          cameraFov: resolveProjectionCameraFov(
            asset.cameraFov,
            resolvedDimensions.imageWidth,
            metadata,
            DEFAULT_CAMERA_FOV
          ),
          imageWidth: resolvedDimensions.imageWidth,
          imageHeight: resolvedDimensions.imageHeight,
          lrfDistance: asset.lrfDistance ?? undefined,
          lrfTargetLat: asset.lrfTargetLat ?? undefined,
          lrfTargetLon: asset.lrfTargetLon ?? undefined,
        },
        normalizedPixel,
        false
      );
      const geo = standardResult instanceof Promise ? await standardResult : standardResult;
      return { lat: geo.lat, lon: geo.lon };
    } catch {
      return null;
    }
  }

  const precisionParams = extractPrecisionParams({
    ...metadata,
    ExifImageWidth: resolvedDimensions.imageWidth,
    ExifImageHeight: resolvedDimensions.imageHeight,
    GpsLatitude: asset.gpsLatitude,
    GpsLongitude: asset.gpsLongitude,
    AbsoluteAltitude: resolvedAltitude,
    GimbalPitchDegree: asset.gimbalPitch,
    GimbalRollDegree: asset.gimbalRoll,
    GimbalYawDegree: asset.gimbalYaw,
    LRFTargetDistance: asset.lrfDistance ?? undefined,
    LRFTargetLat: asset.lrfTargetLat ?? undefined,
    LRFTargetLon: asset.lrfTargetLon ?? undefined,
  });

  const result = await precisionPixelToGeo(normalizedPixel, precisionParams);
  if (!result) {
    return null;
  }

  return { lat: result.latitude, lon: result.longitude };
}
