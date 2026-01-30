import type { CenterBox, YOLOPreprocessingMeta } from '@/lib/types/detection';
import { precisionPixelToGeo, extractPrecisionParams } from '@/lib/utils/precision-georeferencing';

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
  const required: Array<keyof GeoAssetParams> = [
    'gpsLatitude',
    'gpsLongitude',
    'altitude',
    'gimbalPitch',
    'gimbalRoll',
    'gimbalYaw',
    'imageWidth',
    'imageHeight',
  ];

  const missing = required.filter((field) => asset[field] == null);
  return {
    valid: missing.length === 0,
    missingFields: missing as string[],
    warnings: missing.length > 0 ? [`Missing EXIF: ${missing.join(', ')}`] : [],
  };
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

  const metersPerLat = 111111; // approximately
  const metersPerLon = 111111 * Math.cos(params.gpsLatitude * Math.PI / 180);

  if (useLrf && params.lrfTargetLat !== undefined && params.lrfTargetLon !== undefined) {
    // Off-center LRF targeting and projection
    const normalizedX = (pixel.x / params.imageWidth) - 0.5;
    const normalizedY = (pixel.y / params.imageHeight) - 0.5;
    
    // Calculate offset based on camera FOV and normalized coordinates
    const hFov = params.cameraFov * Math.PI / 180;
    const vFov = hFov * params.imageHeight / params.imageWidth;
    
    const angleX = normalizedX * hFov;
    const angleY = normalizedY * vFov;
    
    // Apply gimbal rotations
    const distance = params.lrfDistance || params.altitude;
    const offsetEast = distance * Math.tan(angleX);
    const offsetNorth = distance * Math.tan(angleY);

    const resultLat = params.lrfTargetLat + offsetNorth / metersPerLat;
    const resultLon = params.lrfTargetLon + offsetEast / metersPerLon;

    // SAFETY: Validate before returning (throws on invalid)
    assertValidGeoCoordinates(resultLat, resultLon, 'LRF-based');

    return { lat: resultLat, lon: resultLon };
  }

  // Standard method without LRF
  const normalizedX = (pixel.x / params.imageWidth) - 0.5;
  const normalizedY = (pixel.y / params.imageHeight) - 0.5;
  
  // Calculate field of view angles
  const hFov = params.cameraFov * Math.PI / 180;
  const vFov = hFov * params.imageHeight / params.imageWidth;
  
  // Calculate ray angles
  const rayAngleX = normalizedX * hFov;
  const rayAngleY = normalizedY * vFov;
  
  // Apply gimbal rotations (simplified)
  const pitch = params.gimbalPitch * Math.PI / 180;
  const yaw = params.gimbalYaw * Math.PI / 180;
  
  // Calculate ground distance
  const groundDistance = params.altitude / Math.cos(pitch + rayAngleY);
  
  // Calculate offsets
  const offsetX = groundDistance * Math.tan(rayAngleX);
  const offsetY = groundDistance * Math.sin(pitch + rayAngleY);
  
  // Rotate by yaw
  const bearingRad = yaw;
  const rotatedOffsetX = offsetX * Math.sin(bearingRad) + offsetY * Math.cos(bearingRad);
  const rotatedOffsetY = offsetX * Math.cos(bearingRad) - offsetY * Math.sin(bearingRad);
  
  // Convert to lat/lon
  const latOffset = rotatedOffsetY / metersPerLat;
  const lonOffset = rotatedOffsetX / metersPerLon;
  
  const finalLat = params.gpsLatitude + latOffset;
  const finalLon = params.gpsLongitude + lonOffset;

  // If DTM data is available, refine with terrain height
  if (params.dtmData) {
    return params.dtmData(finalLat, finalLon).then(terrainHeight => {
      const adjustedAltitude = params.altitude - terrainHeight;
      const adjustedDistance = adjustedAltitude / Math.cos(pitch + rayAngleY);
      const adjustedOffsetX = adjustedDistance * Math.tan(rayAngleX);
      const adjustedOffsetY = adjustedDistance * Math.sin(pitch + rayAngleY);

      const adjustedRotatedX = adjustedOffsetX * Math.sin(bearingRad) + adjustedOffsetY * Math.cos(bearingRad);
      const adjustedRotatedY = adjustedOffsetX * Math.cos(bearingRad) - adjustedOffsetY * Math.sin(bearingRad);

      const dtmLat = params.gpsLatitude + adjustedRotatedY / metersPerLat;
      const dtmLon = params.gpsLongitude + adjustedRotatedX / metersPerLon;

      // SAFETY: Validate DTM-adjusted coordinates before returning (throws on invalid)
      assertValidGeoCoordinates(dtmLat, dtmLon, 'DTM-adjusted');

      return { lat: dtmLat, lon: dtmLon };
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
  const normalizedX = (pixel.x / imageWidth) - 0.5;
  const normalizedY = (pixel.y / imageHeight) - 0.5;
  
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
    lrfDistance: meta.LRFDistance,
    lrfTargetLat: meta.LRFTargetLat,
    lrfTargetLon: meta.LRFTargetLon
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

  const precisionParams = extractPrecisionParams({
    ...metadata,
    ExifImageWidth: asset.imageWidth,
    ExifImageHeight: asset.imageHeight,
    GpsLatitude: asset.gpsLatitude,
    GpsLongitude: asset.gpsLongitude,
    AbsoluteAltitude: asset.altitude,
    GimbalPitchDegree: asset.gimbalPitch,
    GimbalRollDegree: asset.gimbalRoll,
    GimbalYawDegree: asset.gimbalYaw,
    LRFTargetDistance: asset.lrfDistance ?? undefined,
    LRFTargetLat: asset.lrfTargetLat ?? undefined,
    LRFTargetLon: asset.lrfTargetLon ?? undefined,
  });

  const result = await precisionPixelToGeo(pixel, precisionParams);
  if (!result) {
    return null;
  }

  return { lat: result.latitude, lon: result.longitude };
}
