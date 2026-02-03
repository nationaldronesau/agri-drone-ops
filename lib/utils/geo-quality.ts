export type GeoQuality = 'high' | 'medium' | 'low' | 'missing';

interface GeoQualityInput {
  gpsLatitude?: number | null;
  gpsLongitude?: number | null;
  altitude?: number | null;
  gimbalPitch?: number | null;
  gimbalRoll?: number | null;
  gimbalYaw?: number | null;
  imageWidth?: number | null;
  imageHeight?: number | null;
  cameraFov?: number | null;
  lrfDistance?: number | null;
  lrfTargetLat?: number | null;
  lrfTargetLon?: number | null;
  metadata?: Record<string, unknown> | null;
}

export interface GeoQualityResult {
  quality: GeoQuality;
  missing: string[];
  hasCalibration: boolean;
  hasLRF: boolean;
}

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

const readNumber = (metadata: Record<string, unknown>, keys: string[]): number | undefined => {
  for (const key of keys) {
    const value = toNumber(metadata[key]);
    if (value != null) return value;
  }
  return undefined;
};

const META_KEYS = {
  calibratedFocalLength: ['CalibratedFocalLength', 'drone-dji:CalibratedFocalLength'],
  opticalCenterX: ['CalibratedOpticalCenterX', 'drone-dji:CalibratedOpticalCenterX'],
  opticalCenterY: ['CalibratedOpticalCenterY', 'drone-dji:CalibratedOpticalCenterY'],
  fieldOfView: ['FieldOfView', 'drone-dji:FieldOfView', 'FOV', 'CameraFOV'],
  lrfDistance: ['LRFTargetDistance', 'drone-dji:LRFTargetDistance'],
  lrfLat: ['LRFTargetLat', 'drone-dji:LRFTargetLat'],
  lrfLon: ['LRFTargetLon', 'drone-dji:LRFTargetLon'],
};

export function evaluateGeoQuality(asset: GeoQualityInput): GeoQualityResult {
  const missing: string[] = [];
  const hasGps =
    typeof asset.gpsLatitude === 'number' &&
    typeof asset.gpsLongitude === 'number' &&
    Number.isFinite(asset.gpsLatitude) &&
    Number.isFinite(asset.gpsLongitude);

  if (!hasGps) {
    return { quality: 'missing', missing: ['gps'], hasCalibration: false, hasLRF: false };
  }

  const hasImageDims =
    typeof asset.imageWidth === 'number' &&
    typeof asset.imageHeight === 'number' &&
    Number.isFinite(asset.imageWidth) &&
    Number.isFinite(asset.imageHeight);

  if (!hasImageDims) {
    missing.push('image dimensions');
  }

  const hasAltitude = typeof asset.altitude === 'number' && Number.isFinite(asset.altitude);
  if (!hasAltitude) {
    missing.push('altitude');
  }

  const hasOrientation =
    typeof asset.gimbalPitch === 'number' &&
    typeof asset.gimbalYaw === 'number' &&
    Number.isFinite(asset.gimbalPitch) &&
    Number.isFinite(asset.gimbalYaw);
  if (!hasOrientation) {
    missing.push('gimbal angles');
  }

  const metadata =
    asset.metadata && typeof asset.metadata === "object"
      ? (asset.metadata as Record<string, unknown>)
      : {};
  const hasCalibration =
    readNumber(metadata, META_KEYS.calibratedFocalLength) != null &&
    readNumber(metadata, META_KEYS.opticalCenterX) != null &&
    readNumber(metadata, META_KEYS.opticalCenterY) != null;

  const hasFov =
    typeof asset.cameraFov === 'number' && Number.isFinite(asset.cameraFov)
      ? true
      : readNumber(metadata, META_KEYS.fieldOfView) != null;

  const hasLRF =
    (asset.lrfDistance != null && asset.lrfTargetLat != null && asset.lrfTargetLon != null) ||
    (readNumber(metadata, META_KEYS.lrfDistance) != null &&
      readNumber(metadata, META_KEYS.lrfLat) != null &&
      readNumber(metadata, META_KEYS.lrfLon) != null);

  if (!hasCalibration && !hasFov) {
    missing.push('camera calibration');
  }

  if (hasGps && hasImageDims && hasAltitude && hasOrientation && (hasCalibration || hasLRF)) {
    return { quality: 'high', missing, hasCalibration, hasLRF };
  }

  if (hasGps && hasImageDims && hasAltitude) {
    return { quality: 'medium', missing, hasCalibration, hasLRF };
  }

  return { quality: 'low', missing, hasCalibration, hasLRF };
}
