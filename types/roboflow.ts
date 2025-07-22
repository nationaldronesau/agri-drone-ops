// Roboflow API Types

export interface RoboflowPrediction {
  x: number; // Center X coordinate
  y: number; // Center Y coordinate
  width: number; // Bounding box width
  height: number; // Bounding box height
  confidence: number; // Confidence score (0-1)
  class: string; // Detected class name
  detection_id?: string;
}

export interface RoboflowResponse {
  predictions: RoboflowPrediction[];
  image: {
    width: number;
    height: number;
  };
  time?: number; // Inference time in ms
}

export interface Detection extends RoboflowPrediction {
  id: string; // Our internal ID
  modelType: string; // Which model was used
  color: string; // Display color for UI
  geoCoordinates?: {
    latitude: number;
    longitude: number;
  }; // Converted geographic coordinates
}

export interface DetectionResult {
  assetId: string;
  imageUrl: string;
  detections: Detection[];
  processedAt: Date;
  modelTypes: string[];
  metadata?: {
    imageWidth: number;
    imageHeight: number;
    gpsLatitude?: number;
    gpsLongitude?: number;
    altitude?: number;
    gimbalPitch?: number;
    gimbalRoll?: number;
    gimbalYaw?: number;
  };
}