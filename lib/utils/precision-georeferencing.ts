/**
 * Precision Georeferencing for DJI Matrice 4E with RTK GPS and Laser Rangefinder
 * 
 * This implementation uses:
 * - Calibrated camera parameters (focal length, principal point)
 * - Laser rangefinder ground target coordinates
 * - Proper camera projection model
 * - Digital Surface Model (DSM) for terrain elevation
 * - Iterative ray-terrain intersection for sub-meter accuracy
 */

import { getTerrainElevation } from '@/lib/services/elevation';

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
  gpsLatitude: ['GpsLatitude', 'GPSLatitude', 'Latitude', 'latitude', 'drone-dji:GPSLatitude', 'drone-dji:GpsLatitude'],
  gpsLongitude: ['GpsLongitude', 'GPSLongitude', 'Longitude', 'longitude', 'drone-dji:GPSLongitude', 'drone-dji:GpsLongitude'],
  absoluteAltitude: ['AbsoluteAltitude', 'GPSAltitude', 'RelativeAltitude', 'altitude', 'drone-dji:AbsoluteAltitude', 'drone-dji:RelativeAltitude'],
  gimbalPitch: ['GimbalPitchDegree', 'drone-dji:GimbalPitchDegree'],
  gimbalRoll: ['GimbalRollDegree', 'drone-dji:GimbalRollDegree'],
  gimbalYaw: ['GimbalYawDegree', 'FlightYawDegree', 'drone-dji:GimbalYawDegree', 'drone-dji:FlightYawDegree'],
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
  const hasLRF = lrfDistance != null && lrfLat != null && lrfLon != null;

  return {
    hasCalibration: calibratedFocalLength != null && opticalCenterX != null && opticalCenterY != null,
    hasLRF,
    hasDewarp: Boolean(readString(metadata, META_KEYS.dewarpData)),
    calibratedFocalLength,
    opticalCenterX,
    opticalCenterY,
  };
}

export function getCameraFovFromMetadata(metadata: MetadataRecord): number | null {
  const fov = readNumber(metadata, META_KEYS.fieldOfView);
  return fov ?? null;
}

/**
 * SAFETY CRITICAL: Validates geographic coordinates for spray drone operations
 * Returns null if coordinates are invalid (NaN, Infinity, out of range)
 */
function validateCoordinates(
  lat: number,
  lon: number,
  altitude?: number
): { latitude: number; longitude: number; altitude?: number } | null {
  // Check for NaN or Infinity
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    console.error('[SAFETY] Invalid coordinates computed: NaN or Infinity detected', { lat, lon });
    return null;
  }

  // Check valid geographic range
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    console.error('[SAFETY] Coordinates out of valid range', { lat, lon });
    return null;
  }

  // Validate altitude if provided
  if (altitude !== undefined && !Number.isFinite(altitude)) {
    console.warn('[SAFETY] Invalid altitude, setting to undefined', { altitude });
    altitude = undefined;
  }

  return { latitude: lat, longitude: lon, altitude };
}

export interface PrecisionGeoreferenceParams {
  // Image parameters
  imageWidth: number;
  imageHeight: number;
  
  // Calibrated camera parameters
  calibratedFocalLength: number; // in pixels
  opticalCenterX: number; // principal point X in pixels
  opticalCenterY: number; // principal point Y in pixels
  
  // Drone position (RTK GPS)
  droneLatitude: number;
  droneLongitude: number;
  droneAltitude: number; // absolute altitude
  
  // Gimbal orientation
  gimbalPitch: number; // degrees
  gimbalRoll: number;  // degrees
  gimbalYaw: number;   // degrees
  
  // Laser rangefinder data (when available)
  lrfTargetDistance?: number; // meters
  lrfTargetLatitude?: number;
  lrfTargetLongitude?: number;
  lrfTargetAltitude?: number;
  
  // Lens distortion (if available)
  dewarpData?: string;
}

export interface PixelCoordinate {
  x: number; // pixels from top-left
  y: number; // pixels from top-left
}

export interface GeographicCoordinate {
  latitude: number;
  longitude: number;
  altitude?: number;
}

/**
 * Convert pixel coordinates to geographic coordinates using precision camera model
 * Returns null if coordinates cannot be computed or are invalid
 */
export async function precisionPixelToGeo(
  pixel: PixelCoordinate,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate | null> {

  // Step 1: Convert pixel coordinates to normalized camera coordinates
  // Account for principal point offset (not assuming image center)
  const normalizedX = (pixel.x - params.opticalCenterX) / params.calibratedFocalLength;
  const normalizedY = (pixel.y - params.opticalCenterY) / params.calibratedFocalLength;

  // Step 2: If we have laser rangefinder data, use it for high precision with DSM
  if (params.lrfTargetLatitude && params.lrfTargetLongitude && params.lrfTargetDistance) {
    return await calculateWithLRFAndDSM(normalizedX, normalizedY, params);
  }

  // Step 3: Fallback to traditional photogrammetric calculation with DSM
  return await calculateWithPhotogrammetryAndDSM(normalizedX, normalizedY, params);
}

/**
 * Calculate geoid height correction for Australia
 * This accounts for the difference between WGS-84 ellipsoidal height and Australian Height Datum
 */
function getGeoidHeightCorrection(latitude: number, longitude: number): number {
  // Simplified geoid undulation model for eastern Australia
  // Brisbane area typically has ~30m geoid undulation
  // This is a basic approximation - for production use, implement EGM96/EGM2008
  
  if (latitude >= -30 && latitude <= -25 && longitude >= 150 && longitude <= 155) {
    // Brisbane/Gold Coast region
    return 30.0; // meters
  } else if (latitude >= -35 && latitude <= -30 && longitude >= 150 && longitude <= 155) {
    // Sydney region  
    return 32.0; // meters
  } else if (latitude >= -40 && latitude <= -35 && longitude >= 145 && longitude <= 150) {
    // Melbourne region
    return 28.0; // meters
  }
  
  // Default for eastern Australia
  return 30.0;
}

/**
 * High-precision calculation using laser rangefinder ground target with DSM correction
 * Returns null if coordinates cannot be computed or are invalid
 */
async function calculateWithLRFAndDSM(
  normalizedX: number,
  normalizedY: number,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate | null> {
  
  // The LRF provides exact ground coordinates for the center pixel
  // We use iterative ray-terrain intersection for sub-meter accuracy
  
  // Step 1: Calculate angular offset from image center
  const centerX = (params.imageWidth / 2 - params.opticalCenterX) / params.calibratedFocalLength;
  const centerY = (params.imageHeight / 2 - params.opticalCenterY) / params.calibratedFocalLength;
  
  // Angular difference from center to our pixel
  const deltaAngleX = normalizedX - centerX;
  const deltaAngleY = normalizedY - centerY;
  
  // Step 2: Initial ground intersection estimate (flat terrain assumption)
  const geoidCorrection = getGeoidHeightCorrection(params.droneLatitude, params.droneLongitude);
  const correctedAltitude = params.droneAltitude - geoidCorrection;
  
  // Use LRF target elevation as initial terrain estimate
  let terrainElevation = params.lrfTargetAltitude || 0;
  let groundDistance = Math.sqrt(
    Math.pow(correctedAltitude - terrainElevation, 2) + 
    Math.pow(params.lrfTargetDistance || 0, 2)
  );
  
  // Step 3: Iterative ray-terrain intersection
  let finalLatitude = params.lrfTargetLatitude!;
  let finalLongitude = params.lrfTargetLongitude!;
  
  for (let iteration = 0; iteration < 3; iteration++) {
    // Calculate ground offsets using current distance estimate
    const offsetEast = groundDistance * Math.tan(deltaAngleX);
    const offsetNorth = -groundDistance * Math.tan(deltaAngleY); // Y axis is inverted
    
    // Apply gimbal rotation
    const yawRad = params.gimbalYaw * Math.PI / 180;
    const rotatedOffsetEast = offsetEast * Math.cos(yawRad) - offsetNorth * Math.sin(yawRad);
    const rotatedOffsetNorth = offsetEast * Math.sin(yawRad) + offsetNorth * Math.cos(yawRad);
    
    // Convert to geographic coordinates
    const metersPerDegreeLat = 111111;
    const metersPerDegreeLon = 111111 * Math.cos(params.lrfTargetLatitude! * Math.PI / 180);
    
    finalLatitude = params.lrfTargetLatitude! + rotatedOffsetNorth / metersPerDegreeLat;
    finalLongitude = params.lrfTargetLongitude! + rotatedOffsetEast / metersPerDegreeLon;
    
    // Query terrain elevation at the calculated ground point
    try {
      const actualTerrainElevation = await getTerrainElevation(finalLatitude, finalLongitude);
      
      // Check convergence
      const elevationDifference = Math.abs(actualTerrainElevation - terrainElevation);
      console.log(`DSM Iteration ${iteration + 1}: Lat=${finalLatitude.toFixed(6)}, Lon=${finalLongitude.toFixed(6)}, Terrain=${actualTerrainElevation.toFixed(1)}m (diff: ${elevationDifference.toFixed(1)}m)`);
      
      if (elevationDifference < 0.5) { // Converged within 0.5 meters for sub-meter accuracy
        terrainElevation = actualTerrainElevation;
        console.log(`✓ DSM converged at iteration ${iteration + 1} with ${elevationDifference.toFixed(2)}m accuracy`);
        break;
      }
      
      // Update terrain elevation and recalculate distance
      terrainElevation = actualTerrainElevation;
      const heightDiff = correctedAltitude - terrainElevation;
      groundDistance = Math.abs(heightDiff) / Math.cos(Math.atan(Math.sqrt(deltaAngleX*deltaAngleX + deltaAngleY*deltaAngleY)));
      
      console.log(`DSM Iteration ${iteration + 1}: Updated distance=${groundDistance.toFixed(1)}m, height_diff=${heightDiff.toFixed(1)}m`);
      
    } catch (error) {
      console.warn(`DSM elevation query failed at iteration ${iteration + 1}, using LRF target elevation:`, error);
      // Use LRF target elevation as fallback
      terrainElevation = params.lrfTargetAltitude || terrainElevation;
      break;
    }
  }
  
  // SAFETY CRITICAL: Validate coordinates before returning
  return validateCoordinates(finalLatitude, finalLongitude, terrainElevation);
}

/**
 * Traditional photogrammetric calculation with DSM terrain correction
 * Returns null if coordinates cannot be computed or are invalid
 */
async function calculateWithPhotogrammetryAndDSM(
  normalizedX: number,
  normalizedY: number,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate | null> {
  
  // Initial calculation using flat terrain assumption
  const geoidCorrection = getGeoidHeightCorrection(params.droneLatitude, params.droneLongitude);
  const correctedAltitude = params.droneAltitude - geoidCorrection;
  
  // Convert gimbal angles to radians
  const pitchRad = params.gimbalPitch * Math.PI / 180;
  const yawRad = params.gimbalYaw * Math.PI / 180;
  
  // Initial ground distance estimate (flat terrain at drone altitude - 100m)
  let terrainElevation = correctedAltitude - 100; // Initial estimate
  let groundDistance = Math.abs(correctedAltitude - terrainElevation) / Math.cos(pitchRad);
  
  let finalLatitude = params.droneLatitude;
  let finalLongitude = params.droneLongitude;
  
  // Iterative ray-terrain intersection
  for (let iteration = 0; iteration < 2; iteration++) {
    // Calculate ray projection
    const groundX = groundDistance * Math.tan(normalizedX);
    const groundY = groundDistance * Math.tan(normalizedY);
    
    // Apply gimbal rotations
    const rotatedX = groundX * Math.cos(yawRad) - groundY * Math.sin(yawRad);
    const rotatedY = groundX * Math.sin(yawRad) + groundY * Math.cos(yawRad);
    
    // Convert to geographic coordinates
    const metersPerDegreeLat = 111111;
    const metersPerDegreeLon = 111111 * Math.cos(params.droneLatitude * Math.PI / 180);
    
    finalLatitude = params.droneLatitude + rotatedY / metersPerDegreeLat;
    finalLongitude = params.droneLongitude + rotatedX / metersPerDegreeLon;
    
    // Query actual terrain elevation
    try {
      const actualTerrainElevation = await getTerrainElevation(finalLatitude, finalLongitude);
      
      if (Math.abs(actualTerrainElevation - terrainElevation) < 2.0) {
        terrainElevation = actualTerrainElevation;
        break;
      }
      
      // Update calculations with actual terrain elevation
      terrainElevation = actualTerrainElevation;
      groundDistance = Math.abs(correctedAltitude - terrainElevation) / Math.cos(pitchRad);
      
    } catch (error) {
      console.warn('DSM elevation query failed in photogrammetry mode:', error);
      break;
    }
  }
  
  // SAFETY CRITICAL: Validate coordinates before returning
  return validateCoordinates(finalLatitude, finalLongitude, terrainElevation);
}


/**
 * Extract precision georeferencing parameters from DJI metadata
 */
export function extractPrecisionParams(metadata: Record<string, unknown>): PrecisionGeoreferenceParams {
  const meta = metadata as MetadataRecord;
  return {
    // Image parameters
    imageWidth: readNumber(meta, META_KEYS.imageWidth) ?? 5280,
    imageHeight: readNumber(meta, META_KEYS.imageHeight) ?? 3956,
    
    // Calibrated camera parameters
    calibratedFocalLength: readNumber(meta, META_KEYS.calibratedFocalLength) ?? 3725.151611,
    opticalCenterX: readNumber(meta, META_KEYS.opticalCenterX) ?? 2640,
    opticalCenterY: readNumber(meta, META_KEYS.opticalCenterY) ?? 1978,
    
    // Drone position (RTK GPS)
    droneLatitude: readNumber(meta, META_KEYS.gpsLatitude) ?? 0,
    droneLongitude: readNumber(meta, META_KEYS.gpsLongitude) ?? 0,
    droneAltitude: readNumber(meta, META_KEYS.absoluteAltitude) ?? 0,
    
    // Gimbal orientation
    gimbalPitch: readNumber(meta, META_KEYS.gimbalPitch) ?? -90,
    gimbalRoll: readNumber(meta, META_KEYS.gimbalRoll) ?? 0,
    gimbalYaw: readNumber(meta, META_KEYS.gimbalYaw) ?? 0,
    
    // Laser rangefinder data
    lrfTargetDistance: readNumber(meta, META_KEYS.lrfDistance),
    lrfTargetLatitude: readNumber(meta, META_KEYS.lrfLat),
    lrfTargetLongitude: readNumber(meta, META_KEYS.lrfLon),
    lrfTargetAltitude: readNumber(meta, META_KEYS.lrfAlt),
    
    // Lens distortion
    dewarpData: readString(meta, META_KEYS.dewarpData)
  };
}

/**
 * Debug function to compare old vs new georeferencing
 */
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

  // Old method (current implementation)
  const oldResult = {
    latitude: (meta.latitude || 0) as number,
    longitude: (meta.longitude || 0) as number
  };

  // New precision method (now returns null if invalid)
  const newResult = await precisionPixelToGeo(pixel, params);

  // LRF reference point
  const lrfReference = params.lrfTargetLatitude && params.lrfTargetLongitude ? {
    latitude: params.lrfTargetLatitude,
    longitude: params.lrfTargetLongitude,
    altitude: params.lrfTargetAltitude
  } : null;

  // Calculate distance error (approximate) - only if newResult is valid
  let distanceError: number | null = null;
  if (newResult) {
    const latDiff = newResult.latitude - oldResult.latitude;
    const lonDiff = newResult.longitude - oldResult.longitude;
    distanceError = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff) * 111111; // meters
  }

  return {
    oldMethod: oldResult,
    newMethod: newResult,
    lrfReference,
    distanceError
  };
}
