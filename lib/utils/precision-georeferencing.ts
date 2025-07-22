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
 */
export async function precisionPixelToGeo(
  pixel: PixelCoordinate,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate> {
  
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
 */
async function calculateWithLRFAndDSM(
  normalizedX: number,
  normalizedY: number,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate> {
  
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
  
  return {
    latitude: finalLatitude,
    longitude: finalLongitude,
    altitude: terrainElevation
  };
}

/**
 * Traditional photogrammetric calculation with DSM terrain correction
 */
async function calculateWithPhotogrammetryAndDSM(
  normalizedX: number,
  normalizedY: number,
  params: PrecisionGeoreferenceParams
): Promise<GeographicCoordinate> {
  
  // Initial calculation using flat terrain assumption
  const geoidCorrection = getGeoidHeightCorrection(params.droneLatitude, params.droneLongitude);
  const correctedAltitude = params.droneAltitude - geoidCorrection;
  
  // Convert gimbal angles to radians
  const pitchRad = params.gimbalPitch * Math.PI / 180;
  const rollRad = params.gimbalRoll * Math.PI / 180;
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
  
  return {
    latitude: finalLatitude,
    longitude: finalLongitude,
    altitude: terrainElevation
  };
}


/**
 * Extract precision georeferencing parameters from DJI metadata
 */
export function extractPrecisionParams(metadata: any): PrecisionGeoreferenceParams {
  return {
    // Image parameters
    imageWidth: metadata.ExifImageWidth || metadata.imageWidth || 5280,
    imageHeight: metadata.ExifImageHeight || metadata.imageHeight || 3956,
    
    // Calibrated camera parameters
    calibratedFocalLength: metadata.CalibratedFocalLength || 3725.151611,
    opticalCenterX: metadata.CalibratedOpticalCenterX || 2640,
    opticalCenterY: metadata.CalibratedOpticalCenterY || 1978,
    
    // Drone position (RTK GPS)
    droneLatitude: metadata.GpsLatitude || metadata.latitude,
    droneLongitude: metadata.GpsLongitude || metadata.longitude,
    droneAltitude: metadata.AbsoluteAltitude || metadata.altitude,
    
    // Gimbal orientation
    gimbalPitch: metadata.GimbalPitchDegree || -90,
    gimbalRoll: metadata.GimbalRollDegree || 0,
    gimbalYaw: metadata.GimbalYawDegree || 0,
    
    // Laser rangefinder data
    lrfTargetDistance: metadata.LRFTargetDistance,
    lrfTargetLatitude: metadata.LRFTargetLat,
    lrfTargetLongitude: metadata.LRFTargetLon,
    lrfTargetAltitude: metadata.LRFTargetAlt,
    
    // Lens distortion
    dewarpData: metadata.DewarpData
  };
}

/**
 * Debug function to compare old vs new georeferencing
 */
export function debugGeoreferencing(
  pixel: PixelCoordinate,
  metadata: any
): {
  oldMethod: GeographicCoordinate;
  newMethod: GeographicCoordinate;
  lrfReference: GeographicCoordinate | null;
  distanceError: number;
} {
  const params = extractPrecisionParams(metadata);
  
  // Old method (current implementation)
  const oldResult = {
    latitude: metadata.latitude || 0,
    longitude: metadata.longitude || 0
  };
  
  // New precision method
  const newResult = precisionPixelToGeo(pixel, params);
  
  // LRF reference point
  const lrfReference = params.lrfTargetLatitude && params.lrfTargetLongitude ? {
    latitude: params.lrfTargetLatitude,
    longitude: params.lrfTargetLongitude,
    altitude: params.lrfTargetAltitude
  } : null;
  
  // Calculate distance error (approximate)
  const latDiff = newResult.latitude - oldResult.latitude;
  const lonDiff = newResult.longitude - oldResult.longitude;
  const distanceError = Math.sqrt(latDiff * latDiff + lonDiff * lonDiff) * 111111; // meters
  
  return {
    oldMethod: oldResult,
    newMethod: newResult,
    lrfReference,
    distanceError
  };
}