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

// Training upload types
export interface AnnotationBox {
  x: number; // center x in pixels
  y: number; // center y in pixels
  width: number;
  height: number;
  class: string;
}

export interface UploadResponse {
  id: string;
  success: boolean;
  error?: string;
}

export interface BatchUploadResponse {
  success: number;
  failed: number;
  errors: { id: string; error: string }[];
}

export interface DatasetStats {
  totalImages: number;
  byClass: Record<string, number>;
}

export interface TrainingOptions {
  split?: "train" | "valid" | "test";
}

export interface TrainingJob {
  id: string;
  status: string;
}

export interface TrainingStatus {
  id: string;
  status: string;
  progress?: number;
  startedAt?: string;
  completedAt?: string;
}
