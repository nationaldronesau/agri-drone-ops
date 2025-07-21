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

const EARTH_RADIUS = 6371000; // meters

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
    
    return {
      lat: params.lrfTargetLat + offsetNorth / metersPerLat,
      lon: params.lrfTargetLon + offsetEast / metersPerLon
    };
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
  const roll = params.gimbalRoll * Math.PI / 180;
  
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
      
      return {
        lat: params.gpsLatitude + adjustedRotatedY / metersPerLat,
        lon: params.gpsLongitude + adjustedRotatedX / metersPerLon
      };
    });
  }
  
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
  
  return {
    lat: dronePosition.lat + latOffset,
    lon: dronePosition.lon + lonOffset
  };
}

export function boundingBoxToGeoPolygon(
  bbox: PixelCoordinates,
  imageWidth: number,
  imageHeight: number,
  dronePosition: DronePosition,
  cameraParams: CameraParams
): any {
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

export function extractGeoParams(metadata: any): GeoreferenceParams {
  return {
    gpsLatitude: metadata.GPSLatitude,
    gpsLongitude: metadata.GPSLongitude,
    altitude: metadata.RelativeAltitude || metadata.GPSAltitude || 0,
    gimbalRoll: metadata.GimbalRollDegree || 0,
    gimbalPitch: metadata.GimbalPitchDegree || -90,
    gimbalYaw: metadata.GimbalYawDegree || metadata.FlightYawDegree || 0,
    cameraFov: metadata.FieldOfView || 84,
    imageWidth: metadata.ImageWidth || metadata.ExifImageWidth,
    imageHeight: metadata.ImageHeight || metadata.ExifImageHeight,
    lrfDistance: metadata.LRFDistance,
    lrfTargetLat: metadata.LRFTargetLat,
    lrfTargetLon: metadata.LRFTargetLon
  };
}