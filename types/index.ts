export interface User {
  id: string;
  email: string;
  name?: string;
  image?: string;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  role?: 'OWNER' | 'ADMIN' | 'MEMBER';
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  teamId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Asset {
  id: string;
  projectId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  storageUrl: string;
  thumbnailUrl?: string;
  metadata?: any;
  gpsLatitude?: number;
  gpsLongitude?: number;
  altitude?: number;
  gimbalRoll?: number;
  gimbalPitch?: number;
  gimbalYaw?: number;
  cameraFov?: number;
  imageWidth?: number;
  imageHeight?: number;
  lrfDistance?: number;
  lrfTargetLat?: number;
  lrfTargetLon?: number;
  createdAt: Date;
}

export interface ProcessingJob {
  id: string;
  projectId: string;
  type: 'AI_DETECTION' | 'MANUAL_ANNOTATION';
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  config?: any;
  progress: number;
  errorMessage?: string;
  startedAt?: Date;
  completedAt?: Date;
  createdAt: Date;
}

export interface Detection {
  id: string;
  jobId: string;
  assetId: string;
  type: 'AI' | 'MANUAL';
  className: string;
  confidence?: number;
  boundingBox: any;
  geoCoordinates: any;
  centerLat?: number;
  centerLon?: number;
  metadata?: any;
  verified: boolean;
  createdAt: Date;
}

export interface ChemicalRecommendation {
  id: string;
  species: string;
  chemical: string;
  dosagePerHa: number;
  notes?: string;
}