import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';
import {
  getPrecisionMetadataStatus,
  getCameraFovFromMetadata,
} from '@/lib/utils/precision-georeferencing';
import {
  projectPixelToGeo,
  projectPixelToGeoAtHeight,
  type ProjectionCoreResult,
  type ProjectionMethod,
} from '@/lib/utils/projection-core';

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
  opticalCenterX?: number;
  opticalCenterY?: number;
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
  method?: ProjectionMethod;
  offsetFromCentreM?: number;
  qualityFlags?: string[];
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
const ALTITUDE_SCALE_META_KEYS = ['GeoAltitudeScale', 'geoAltitudeScale'];
const ABSOLUTE_ALTITUDE_META_KEYS = [
  'AbsoluteAltitude',
  'GPSAltitude',
  'altitude',
  'drone-dji:AbsoluteAltitude',
];
const FOV_SCALE_META_KEYS = ['GeoFovScale', 'geoFovScale'];
const YAW_OFFSET_META_KEYS = ['GeoYawOffsetDeg', 'geoYawOffsetDeg', 'YawOffsetDeg'];
const OPTICAL_CENTER_X_META_KEYS = [
  'CalibratedOpticalCenterX',
  'drone-dji:CalibratedOpticalCenterX',
  'OpticalCenterX',
  'geoOpticalCenterX',
];
const OPTICAL_CENTER_Y_META_KEYS = [
  'CalibratedOpticalCenterY',
  'drone-dji:CalibratedOpticalCenterY',
  'OpticalCenterY',
  'geoOpticalCenterY',
];
const IMAGE_WIDTH_META_KEYS = ['ExifImageWidth', 'ImageWidth', 'PixelXDimension', 'imageWidth'];
const IMAGE_HEIGHT_META_KEYS = ['ExifImageHeight', 'ImageHeight', 'PixelYDimension', 'imageHeight'];
const LRF_DISTANCE_META_KEYS = ['LRFTargetDistance', 'drone-dji:LRFTargetDistance'];
const LRF_LAT_META_KEYS = ['LRFTargetLat', 'drone-dji:LRFTargetLat'];
const LRF_LON_META_KEYS = ['LRFTargetLon', 'drone-dji:LRFTargetLon'];

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

function readMetadataScale(
  metadata: Record<string, unknown>,
  keys: string[],
  min: number,
  max: number
): number | null {
  const value = readMetadataNumber(metadata, keys);
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  if (value < min || value > max) {
    return null;
  }
  return value;
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
  const altitudeScale = readMetadataScale(record, ALTITUDE_SCALE_META_KEYS, 0.5, 1.5);
  const applyScale = (value: number): number => (altitudeScale != null ? value * altitudeScale : value);
  const relativeAltitude = readMetadataNumber(record, RELATIVE_ALTITUDE_META_KEYS);
  if (isPositiveFinite(relativeAltitude)) {
    return applyScale(relativeAltitude);
  }

  if (isPositiveFinite(altitude)) {
    return applyScale(altitude);
  }

  const absoluteAltitude = readMetadataNumber(record, ABSOLUTE_ALTITUDE_META_KEYS);
  if (isPositiveFinite(absoluteAltitude)) {
    return applyScale(absoluteAltitude);
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
  const fovScale = readMetadataScale(record, FOV_SCALE_META_KEYS, 0.5, 1.5);
  const calibratedFocalLength = readMetadataNumber(record, CALIBRATED_FOCAL_META_KEYS);
  const derivedCalibrationFov = deriveHorizontalFovFromCalibration(imageWidth, calibratedFocalLength);
  const focalLength35mm = readMetadataNumber(record, FOCAL_LENGTH_35MM_META_KEYS);
  const derived35mmFov = deriveHorizontalFovFrom35mmEquivalent(focalLength35mm);
  const metadataFov = readMetadataNumber(record, CAMERA_FOV_META_KEYS);
  const parsedMetadataFov = isValidFov(metadataFov) ? metadataFov : null;
  const explicitFov = isValidFov(cameraFov) ? cameraFov : null;

  let resolvedFov: number;
  if (
    derivedCalibrationFov != null &&
    (explicitFov == null || Math.abs(explicitFov - fallbackFov) < 0.01)
  ) {
    resolvedFov = derivedCalibrationFov;
  } else if (
    derived35mmFov != null &&
    (explicitFov == null || Math.abs(explicitFov - fallbackFov) < 0.01)
  ) {
    resolvedFov = derived35mmFov;
  } else if (explicitFov != null) {
    resolvedFov = explicitFov;
  } else if (derivedCalibrationFov != null) {
    resolvedFov = derivedCalibrationFov;
  } else if (parsedMetadataFov != null) {
    resolvedFov = parsedMetadataFov;
  } else {
    const legacyFov = getCameraFovFromMetadata(record);
    if (legacyFov != null && isValidFov(legacyFov)) {
      resolvedFov = legacyFov;
    } else if (derived35mmFov != null) {
      resolvedFov = derived35mmFov;
    } else {
      resolvedFov = fallbackFov;
    }
  }

  if (fovScale != null) {
    const scaled = resolvedFov * fovScale;
    if (isValidFov(scaled)) {
      return scaled;
    }
  }
  return resolvedFov;
}

export function resolveProjectionYaw(
  gimbalYaw: number | null | undefined,
  metadata?: unknown | null
): number {
  const record = asMetadataRecord(metadata);
  const baseYaw = toFiniteNumber(gimbalYaw) ?? 0;
  const yawOffset = readMetadataNumber(record, YAW_OFFSET_META_KEYS);
  if (yawOffset == null || !Number.isFinite(yawOffset) || Math.abs(yawOffset) > 45) {
    return baseYaw;
  }
  return baseYaw + yawOffset;
}

export function resolveProjectionOpticalCenter(
  imageWidth: number,
  imageHeight: number,
  metadata?: unknown | null
): { opticalCenterX: number; opticalCenterY: number } {
  const record = asMetadataRecord(metadata);
  const defaultCenterX = imageWidth / 2;
  const defaultCenterY = imageHeight / 2;
  const metadataCenterX = readMetadataNumber(record, OPTICAL_CENTER_X_META_KEYS);
  const metadataCenterY = readMetadataNumber(record, OPTICAL_CENTER_Y_META_KEYS);

  const opticalCenterX =
    metadataCenterX != null &&
    Number.isFinite(metadataCenterX) &&
    metadataCenterX >= 0 &&
    metadataCenterX <= imageWidth
      ? metadataCenterX
      : defaultCenterX;

  const opticalCenterY =
    metadataCenterY != null &&
    Number.isFinite(metadataCenterY) &&
    metadataCenterY >= 0 &&
    metadataCenterY <= imageHeight
      ? metadataCenterY
      : defaultCenterY;

  return { opticalCenterX, opticalCenterY };
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

function hasPlausibleLrfTarget(asset: GeoAssetParams): boolean {
  if (
    typeof asset.gpsLatitude !== 'number' ||
    typeof asset.gpsLongitude !== 'number' ||
    typeof asset.lrfDistance !== 'number' ||
    !Number.isFinite(asset.gpsLatitude) ||
    !Number.isFinite(asset.gpsLongitude) ||
    !Number.isFinite(asset.lrfDistance) ||
    asset.lrfDistance <= 0
  ) {
    return false;
  }

  // The range alone is sufficient to resolve AGL from the boresight. When DJI
  // also supplies target coordinates, retain the legacy plausibility guard.
  if (asset.lrfTargetLat == null && asset.lrfTargetLon == null) {
    return true;
  }
  if (
    typeof asset.lrfTargetLat !== 'number' ||
    typeof asset.lrfTargetLon !== 'number' ||
    !Number.isFinite(asset.lrfTargetLat) ||
    !Number.isFinite(asset.lrfTargetLon)
  ) {
    return false;
  }

  const gpsToLrfMeters = haversineDistanceMeters(
    asset.gpsLatitude,
    asset.gpsLongitude,
    asset.lrfTargetLat,
    asset.lrfTargetLon
  );
  const maxExpectedOffset = Math.max(
    DEFAULT_MAX_LRF_OFFSET_M,
    asset.lrfDistance * 8 + 500
  );
  return Number.isFinite(gpsToLrfMeters) && gpsToLrfMeters <= maxExpectedOffset;
}

function isValidGeoPoint(lat: number, lon: number): boolean {
  return validateGeoCoordinates(lat, lon).valid;
}

function resultToGeoPoint(result: ProjectionCoreResult): GeoPoint {
  return {
    lat: result.lat,
    lon: result.lon,
    method: result.method,
    offsetFromCentreM: result.offsetFromCentreM,
    qualityFlags: result.qualityFlags,
  };
}

async function projectAssetThroughCore(
  asset: GeoAssetParams,
  pixel: PixelPoint,
  options?: { fallbackAltitude?: number; fallbackFov?: number }
): Promise<ProjectionCoreResult | null> {
  const gpsLat = asset.gpsLatitude;
  const gpsLon = asset.gpsLongitude;
  const metadata = asMetadataRecord(asset.metadata);
  const resolvedDimensions = resolveProjectionImageDimensions(
    asset.imageWidth,
    asset.imageHeight,
    metadata
  );
  const width = resolvedDimensions.imageWidth;
  const height = resolvedDimensions.imageHeight;
  if (
    typeof gpsLat !== 'number' ||
    typeof gpsLon !== 'number' ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isFinite(gpsLat) ||
    !Number.isFinite(gpsLon) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }

  let normalizedPixel: PixelPoint;
  try {
    normalizedPixel = normalizePixelPoint(pixel, width, height);
  } catch {
    return null;
  }

  const resolvedAltitude = resolveProjectionAltitude(asset.altitude, metadata);
  const fallbackAltitude = options?.fallbackAltitude ?? DEFAULT_ALTITUDE;
  const resolvedYaw = resolveProjectionYaw(asset.gimbalYaw, metadata);
  const cameraFov = resolveProjectionCameraFov(
    asset.cameraFov,
    width,
    metadata,
    options?.fallbackFov ?? DEFAULT_CAMERA_FOV
  );
  const opticalCenter = resolveProjectionOpticalCenter(width, height, metadata);
  const precisionStatus = getPrecisionMetadataStatus(metadata);
  const calibratedFocalLength = readMetadataNumber(metadata, CALIBRATED_FOCAL_META_KEYS);
  const fovScale = readMetadataScale(metadata, FOV_SCALE_META_KEYS, 0.5, 1.5);
  const altitudeScale = readMetadataScale(metadata, ALTITUDE_SCALE_META_KEYS, 0.5, 1.5);
  const relativeAltitude = readMetadataNumber(metadata, RELATIVE_ALTITUDE_META_KEYS);
  const absoluteAltitude = readMetadataNumber(metadata, ABSOLUTE_ALTITUDE_META_KEYS);
  const scaledAbsoluteAltitude =
    absoluteAltitude != null ? absoluteAltitude * (altitudeScale ?? 1) : null;
  const lrfTargetElevation = readMetadataNumber(metadata, [
    'LRFTargetAlt',
    'drone-dji:LRFTargetAlt',
  ]);
  const lrfDistance = asset.lrfDistance ?? readMetadataNumber(metadata, LRF_DISTANCE_META_KEYS);
  const lrfTargetLat = asset.lrfTargetLat ?? readMetadataNumber(metadata, LRF_LAT_META_KEYS);
  const lrfTargetLon = asset.lrfTargetLon ?? readMetadataNumber(metadata, LRF_LON_META_KEYS);
  const lrfAsset: GeoAssetParams = {
    ...asset,
    lrfDistance,
    lrfTargetLat,
    lrfTargetLon,
  };
  const hasPlausibleLrf = hasPlausibleLrfTarget(lrfAsset);
  const hasTypedAltitude = isPositiveFinite(relativeAltitude) || isPositiveFinite(absoluteAltitude);
  const projectionAltitudeForCap =
    !isPositiveFinite(relativeAltitude) && isPositiveFinite(scaledAbsoluteAltitude)
      ? scaledAbsoluteAltitude
      : resolvedAltitude;
  const qualityFlags: string[] = [];
  if (
    !precisionStatus.hasCalibration &&
    !isValidFov(asset.cameraFov) &&
    !isValidFov(readMetadataNumber(metadata, CAMERA_FOV_META_KEYS)) &&
    !isPositiveFinite(readMetadataNumber(metadata, FOCAL_LENGTH_35MM_META_KEYS))
  ) {
    qualityFlags.push('default_fov');
  }

  const maxOffsetMeters = computeProjectionMaxOffsetMeters(
    projectionAltitudeForCap ?? fallbackAltitude,
    cameraFov,
    width,
    height
  );

  const result = await projectPixelToGeo({
    pixel: normalizedPixel,
    imageWidth: width,
    imageHeight: height,
    intrinsics:
      precisionStatus.hasCalibration && calibratedFocalLength != null
        ? fovScale != null
          ? {
              cx: opticalCenter.opticalCenterX,
              cy: opticalCenter.opticalCenterY,
            }
          : {
              f: calibratedFocalLength,
              cx: opticalCenter.opticalCenterX,
              cy: opticalCenter.opticalCenterY,
            }
        : undefined,
    fieldOfViewDeg: cameraFov,
    gimbalPitchDeg: asset.gimbalPitch ?? 0,
    gimbalRollDeg: asset.gimbalRoll ?? 0,
    gimbalYawDeg: resolvedYaw,
    droneLat: gpsLat,
    droneLon: gpsLon,
    lrfDistanceM: hasPlausibleLrf ? lrfDistance : undefined,
    lrfTargetLat: hasPlausibleLrf ? lrfTargetLat : undefined,
    lrfTargetLon: hasPlausibleLrf ? lrfTargetLon : undefined,
    relativeAltitudeM: isPositiveFinite(relativeAltitude)
      ? resolvedAltitude
      : undefined,
    absoluteAltitudeM:
      !isPositiveFinite(relativeAltitude) && isPositiveFinite(absoluteAltitude)
        ? scaledAbsoluteAltitude
        : undefined,
    heightAboveGroundM:
      !hasTypedAltitude && isPositiveFinite(resolvedAltitude)
        ? resolvedAltitude
        : undefined,
    lrfTargetElevationM: lrfTargetElevation,
    defaultAltitudeM: resolvedAltitude == null ? fallbackAltitude : undefined,
    maxOffsetM: maxOffsetMeters,
    qualityFlags,
  });

  // A null projection is an intentional safety rejection. Detection/export
  // callers already skip or flag it; never substitute or relocate a coordinate.
  if (!result || !isValidGeoPoint(result.lat, result.lon)) {
    return null;
  }
  return result;
}

/**
 * Export/review projection. Uses the exact same adapter as detection resolution;
 * null means the coordinate was rejected and must be skipped/flagged by the caller.
 */
export async function computeExportProjectionGeo(
  asset: GeoAssetParams,
  pixel: PixelPoint,
  options?: { fallbackAltitude?: number; fallbackFov?: number }
): Promise<GeoPoint | null> {
  const result = await projectAssetThroughCore(asset, pixel, options);
  return result ? resultToGeoPoint(result) : null;
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
  const metadata = asMetadataRecord(asset.metadata);
  if (asset.gpsLatitude == null) missing.push('gpsLatitude');
  if (asset.gpsLongitude == null) missing.push('gpsLongitude');
  if (asset.gimbalPitch == null) missing.push('gimbalPitch');
  if (asset.gimbalRoll == null) missing.push('gimbalRoll');
  if (asset.gimbalYaw == null) missing.push('gimbalYaw');

  const resolvedAltitude = resolveProjectionAltitude(asset.altitude, asset.metadata);
  const hasUsableLrf =
    isPositiveFinite(asset.lrfDistance) ||
    isPositiveFinite(readMetadataNumber(metadata, LRF_DISTANCE_META_KEYS));
  if (resolvedAltitude == null && !hasUsableLrf) {
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

export type GeoResolutionMethod = ProjectionMethod;

export interface GeoResolution {
  geo: GeoPoint;
  method: GeoResolutionMethod;
  qualityFlags: string[];
}

export async function resolveGeoCoordinates(
  asset: GeoAssetParams,
  pixel: PixelPoint
): Promise<GeoResolution | null> {
  // Detection callers treat null as a skipped/flagged coordinate.
  const result = await projectAssetThroughCore(asset, pixel);
  if (!result) return null;
  return {
    geo: resultToGeoPoint(result),
    method: result.method,
    qualityFlags: result.qualityFlags,
  };
}

export async function pixelToGeo(
  params: GeoreferenceParams,
  pixel: PixelPoint,
  useLrf: boolean = true
): Promise<GeoPoint> {
  if (!params || !pixel) {
    throw new Error('Invalid parameters');
  }
  if (!isPositiveFinite(params.imageWidth) || !isPositiveFinite(params.imageHeight)) {
    throw new Error('Invalid image dimensions');
  }
  const normalizedPixel = normalizePixelPoint(pixel, params.imageWidth, params.imageHeight);
  const opticalCenterX =
    typeof params.opticalCenterX === 'number' &&
    Number.isFinite(params.opticalCenterX) &&
    params.opticalCenterX >= 0 &&
    params.opticalCenterX <= params.imageWidth
      ? params.opticalCenterX
      : params.imageWidth / 2;
  const opticalCenterY =
    typeof params.opticalCenterY === 'number' &&
    Number.isFinite(params.opticalCenterY) &&
    params.opticalCenterY >= 0 &&
    params.opticalCenterY <= params.imageHeight
      ? params.opticalCenterY
      : params.imageHeight / 2;

  const maxOffsetMeters = computeProjectionMaxOffsetMeters(
    params.altitude,
    params.cameraFov,
    params.imageWidth,
    params.imageHeight
  );
  const lrfAsset: GeoAssetParams = {
    gpsLatitude: params.gpsLatitude,
    gpsLongitude: params.gpsLongitude,
    altitude: params.altitude,
    gimbalPitch: params.gimbalPitch,
    gimbalRoll: params.gimbalRoll,
    gimbalYaw: params.gimbalYaw,
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    lrfDistance: params.lrfDistance ?? null,
    lrfTargetLat: params.lrfTargetLat ?? null,
    lrfTargetLon: params.lrfTargetLon ?? null,
  };
  const result = await projectPixelToGeo({
    pixel: normalizedPixel,
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    fieldOfViewDeg: params.cameraFov,
    intrinsics: { cx: opticalCenterX, cy: opticalCenterY },
    gimbalPitchDeg: params.gimbalPitch,
    gimbalRollDeg: params.gimbalRoll,
    gimbalYawDeg: params.gimbalYaw,
    droneLat: params.gpsLatitude,
    droneLon: params.gpsLongitude,
    lrfDistanceM: useLrf && hasPlausibleLrfTarget(lrfAsset) ? params.lrfDistance : undefined,
    relativeAltitudeM: params.dtmData ? params.altitude : undefined,
    heightAboveGroundM: params.dtmData ? undefined : params.altitude,
    terrainElevation: params.dtmData,
    maxOffsetM: maxOffsetMeters,
  });
  if (!result) {
    throw new Error('Projection failed validation or ray was near the horizon');
  }
  assertValidGeoCoordinates(result.lat, result.lon, 'projection-core');
  return resultToGeoPoint(result);
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
  const result = projectPixelToGeoAtHeight(
    {
      pixel: normalizedPixel,
      imageWidth,
      imageHeight,
      fieldOfViewDeg: cameraParams.fov,
      gimbalPitchDeg: dronePosition.pitch,
      gimbalRollDeg: dronePosition.roll,
      gimbalYawDeg: dronePosition.yaw,
      droneLat: dronePosition.lat,
      droneLon: dronePosition.lon,
    },
    dronePosition.altitude
  );
  if (!result) {
    throw new Error('Simplified projection failed validation or ray was near the horizon');
  }
  assertValidGeoCoordinates(result.lat, result.lon, 'simplified');
  return { lat: result.lat, lon: result.lon };
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
  // Export callers treat null as a skipped/flagged coordinate.
  const result = await projectAssetThroughCore(asset, pixel);
  return result ? resultToGeoPoint(result) : null;
}
