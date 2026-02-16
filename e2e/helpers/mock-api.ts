import { Page, Route } from "@playwright/test";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | { [key: string]: JsonValue }
  | JsonValue[];

type Project = {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
  season?: string | null;
  cameraProfileId?: string | null;
  activeModelId?: string | null;
  autoInferenceEnabled?: boolean;
  inferenceBackend?: "LOCAL" | "ROBOFLOW" | "AUTO" | null;
};

type CameraProfile = {
  id: string;
  name: string;
  description?: string | null;
  fov?: number | null;
  calibratedFocalLength?: number | null;
  opticalCenterX?: number | null;
  opticalCenterY?: number | null;
};

type Asset = {
  id: string;
  fileName: string;
  storageUrl: string;
  fileSize: number;
  mimeType: string;
  annotationCount: number;
  geoQuality: "high" | "medium" | "low" | "missing";
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  createdAt: string;
  imageWidth: number;
  imageHeight: number;
  metadata: Record<string, JsonValue>;
  project: { id: string; name: string; location: string | null };
};

type Detection = {
  id: string;
  className: string;
  confidence: number;
  centerLat: number | null;
  centerLon: number | null;
  verified?: boolean;
  rejected?: boolean;
  metadata: Record<string, JsonValue>;
  asset: {
    id: string;
    fileName: string;
    altitude: number | null;
    project: { name: string; location: string | null };
  };
};

type ReviewSession = {
  id: string;
  projectId: string;
  workflowType: string;
  assetCount: number;
  itemsReviewed: number;
  itemsAccepted: number;
  itemsRejected: number;
  status: string;
  createdAt: string;
  project: { id: string; name: string };
  roboflowProjectId?: string | null;
  confidenceThreshold?: number | null;
  inferenceJobIds?: string[];
  batchJobIds?: string[];
  assignedTo?: { id: string; name: string; email?: string | null } | null;
};

type ReviewItem = {
  id: string;
  source: "manual" | "pending" | "detection";
  sourceId: string;
  assetId: string;
  asset: {
    id: string;
    fileName: string;
    storageUrl: string;
    imageWidth?: number | null;
    imageHeight?: number | null;
    gpsLatitude?: number | null;
    gpsLongitude?: number | null;
    altitude?: number | null;
    gimbalPitch?: number | null;
    gimbalRoll?: number | null;
    gimbalYaw?: number | null;
  };
  className: string;
  confidence: number;
  geometry: {
    type: "polygon" | "bbox";
    polygon?: number[][];
    bbox?: [number, number, number, number];
    bboxCenter?: { x: number; y: number; width: number; height: number };
  };
  status: "pending" | "accepted" | "rejected";
  correctedClass?: string | null;
  hasGeoData: boolean;
  warnings: string[];
};

type ManualAnnotation = {
  id: string;
  weedType: string;
  confidence: "CERTAIN" | "LIKELY" | "UNCERTAIN";
  coordinates: [number, number][];
  notes?: string;
  verified: boolean;
  verifiedAt?: string | null;
  pushedToTraining?: boolean;
  pushedAt?: string | null;
  roboflowImageId?: string | null;
};

type AnnotationSession = {
  id: string;
  status: "IN_PROGRESS" | "COMPLETED";
  createdAt: string;
  updatedAt: string;
  asset: Asset;
  annotations: ManualAnnotation[];
};

type SprayPlan = {
  id: string;
  name: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
  project: { id: string; name: string; location: string | null };
  _count: { missions: number; zones: number };
};

type Orthomosaic = {
  id: string;
  name: string;
  description: string | null;
  fileSize: number;
  centerLat: number;
  centerLon: number;
  captureDate: string | null;
  resolution: number | null;
  area: number | null;
  imageCount: number | null;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  createdAt: string;
  project: { id: string; name: string; location: string | null };
  projectId: string;
  bounds?: {
    type: string;
    coordinates: Array<Array<[number, number]>>;
  };
  minZoom?: number;
  maxZoom?: number;
};

type TrainingDataset = {
  id: string;
  name: string;
  description?: string | null;
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classes: string[];
  augmentationPreset?: string | null;
  augmentationConfig?: Record<string, JsonValue> | null;
  createdAt: string;
  project?: { id: string; name: string } | null;
};

type TrainingJob = {
  id: string;
  status: "QUEUED" | "PREPARING" | "RUNNING" | "UPLOADING" | "COMPLETED" | "FAILED" | "CANCELLED";
  baseModel: string;
  epochs: number;
  batchSize: number;
  imageSize: number;
  currentEpoch?: number | null;
  progress?: number | null;
  estimatedMinutes?: number | null;
  startedAt?: string | null;
  createdAt: string;
  errorMessage?: string | null;
  dataset?: {
    id?: string;
    name: string;
    imageCount: number;
    classes: string[];
  } | null;
  currentMetrics?: {
    mAP50?: number;
    precision?: number;
    recall?: number;
  } | null;
  syncStatus?: "ok" | "failed" | null;
  syncError?: string | null;
  syncUpdatedAt?: string | null;
};

type TrainedModel = {
  id: string;
  name: string;
  version: number;
  displayName?: string | null;
  classes?: string[];
  mAP50?: number | null;
  mAP5095?: number | null;
  precision?: number | null;
  recall?: number | null;
  f1Score?: number | null;
  classMetrics?: unknown;
  status: string;
  isActive: boolean;
  createdAt: string;
};

type InferenceJob = {
  id: string;
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  errorMessage?: string | null;
  createdAt: string;
  project: { id: string; name: string };
  config: {
    modelId?: string;
    modelName?: string;
    confidence?: number;
    totalImages?: number;
    processedImages?: number;
    detectionsFound?: number;
    skippedImages?: number;
    duplicateImages?: number;
  };
};

export type MockApiOptions = {
  projects?: Project[];
  cameraProfiles?: CameraProfile[];
  assets?: Asset[];
  detections?: Detection[];
  reviewSessions?: ReviewSession[];
  reviewItemsBySession?: Record<string, ReviewItem[]>;
  annotationSessions?: AnnotationSession[];
  sprayPlans?: SprayPlan[];
  orthomosaics?: Orthomosaic[];
  datasets?: TrainingDataset[];
  trainingJobs?: TrainingJob[];
  trainedModels?: TrainedModel[];
  inferenceJobs?: InferenceJob[];
  trainingAvailable?: boolean;
};

const DEFAULT_PROJECTS: Project[] = [
  {
    id: "proj-1",
    name: "North Farm Survey",
    location: "Queensland",
    purpose: "WEED_DETECTION",
    season: "Summer 2026",
    cameraProfileId: "cam-1",
    activeModelId: "model-1",
    autoInferenceEnabled: true,
    inferenceBackend: "AUTO",
  },
  {
    id: "proj-2",
    name: "Creekline Paddock",
    location: "New South Wales",
    purpose: "CROP_HEALTH",
    season: "Autumn 2026",
    cameraProfileId: null,
    activeModelId: null,
    autoInferenceEnabled: false,
    inferenceBackend: "LOCAL",
  },
];

const DEFAULT_CAMERA_PROFILES: CameraProfile[] = [
  {
    id: "cam-1",
    name: "DJI M4E Wide",
    description: "Default calibrated profile",
    fov: 84,
    calibratedFocalLength: 2920.4,
    opticalCenterX: 2010.1,
    opticalCenterY: 1512.8,
  },
];

const DEFAULT_ASSETS: Asset[] = [
  {
    id: "asset-1",
    fileName: "north-block-001.jpg",
    storageUrl: "/next.svg",
    fileSize: 2_245_778,
    mimeType: "image/jpeg",
    annotationCount: 2,
    geoQuality: "high",
    gpsLatitude: -27.4665,
    gpsLongitude: 153.0237,
    altitude: 78,
    gimbalPitch: -88,
    gimbalRoll: 0.4,
    gimbalYaw: 182.4,
    createdAt: "2026-02-01T09:30:00.000Z",
    imageWidth: 4000,
    imageHeight: 3000,
    metadata: { cameraModel: "DJI M4E" },
    project: { id: "proj-1", name: "North Farm Survey", location: "Queensland" },
  },
  {
    id: "asset-2",
    fileName: "north-block-002.jpg",
    storageUrl: "/vercel.svg",
    fileSize: 2_018_522,
    mimeType: "image/jpeg",
    annotationCount: 0,
    geoQuality: "medium",
    gpsLatitude: -27.4672,
    gpsLongitude: 153.0251,
    altitude: 75,
    gimbalPitch: -87.5,
    gimbalRoll: 0,
    gimbalYaw: 180.2,
    createdAt: "2026-02-01T09:32:00.000Z",
    imageWidth: 4000,
    imageHeight: 3000,
    metadata: { cameraModel: "DJI M4E" },
    project: { id: "proj-1", name: "North Farm Survey", location: "Queensland" },
  },
];

const DEFAULT_DETECTIONS: Detection[] = [
  {
    id: "det-1",
    className: "Lantana",
    confidence: 0.93,
    centerLat: -27.4661,
    centerLon: 153.0232,
    verified: false,
    rejected: false,
    metadata: {
      bbox: [1412, 932, 1668, 1148],
    },
    asset: {
      id: "asset-1",
      fileName: "north-block-001.jpg",
      altitude: 78,
      project: { name: "North Farm Survey", location: "Queensland" },
    },
  },
  {
    id: "det-2",
    className: "Wattle",
    confidence: 0.88,
    centerLat: -27.4678,
    centerLon: 153.0242,
    verified: true,
    rejected: false,
    metadata: {
      bbox: [2080, 1182, 2288, 1394],
    },
    asset: {
      id: "asset-2",
      fileName: "north-block-002.jpg",
      altitude: 75,
      project: { name: "North Farm Survey", location: "Queensland" },
    },
  },
];

const DEFAULT_REVIEW_SESSIONS: ReviewSession[] = [
  {
    id: "review-1",
    projectId: "proj-1",
    workflowType: "improve_model",
    assetCount: 2,
    itemsReviewed: 1,
    itemsAccepted: 1,
    itemsRejected: 0,
    status: "ACTIVE",
    createdAt: "2026-02-14T08:00:00.000Z",
    project: { id: "proj-1", name: "North Farm Survey" },
    roboflowProjectId: "north-farm",
    confidenceThreshold: 0.5,
    inferenceJobIds: [],
    batchJobIds: [],
    assignedTo: null,
  },
];

const DEFAULT_REVIEW_ITEMS_BY_SESSION: Record<string, ReviewItem[]> = {
  "review-1": [
    {
      id: "rev-item-1",
      source: "detection",
      sourceId: "det-1",
      assetId: "asset-1",
      asset: {
        id: "asset-1",
        fileName: "north-block-001.jpg",
        storageUrl: "/next.svg",
        imageWidth: 4000,
        imageHeight: 3000,
        gpsLatitude: -27.4665,
        gpsLongitude: 153.0237,
        altitude: 78,
        gimbalPitch: -88,
        gimbalRoll: 0.4,
        gimbalYaw: 182.4,
      },
      className: "Lantana",
      confidence: 0.88,
      geometry: {
        type: "bbox",
        bbox: [1412, 932, 1668, 1148],
        bboxCenter: { x: 1540, y: 1040, width: 256, height: 216 },
      },
      status: "pending",
      correctedClass: null,
      hasGeoData: true,
      warnings: [],
    },
    {
      id: "rev-item-2",
      source: "manual",
      sourceId: "ann-accepted-1",
      assetId: "asset-2",
      asset: {
        id: "asset-2",
        fileName: "north-block-002.jpg",
        storageUrl: "/vercel.svg",
        imageWidth: 4000,
        imageHeight: 3000,
        gpsLatitude: -27.4672,
        gpsLongitude: 153.0251,
        altitude: 75,
        gimbalPitch: -87.5,
        gimbalRoll: 0,
        gimbalYaw: 180.2,
      },
      className: "Wattle",
      confidence: 0.76,
      geometry: {
        type: "polygon",
        polygon: [
          [1020, 980],
          [1128, 1016],
          [1102, 1132],
          [1004, 1094],
        ],
        bbox: [1004, 980, 1128, 1132],
      },
      status: "accepted",
      correctedClass: null,
      hasGeoData: true,
      warnings: [],
    },
  ],
};

const DEFAULT_ANNOTATION_SESSIONS: AnnotationSession[] = [
  {
    id: "session-asset-1",
    status: "IN_PROGRESS",
    createdAt: "2026-02-14T08:10:00.000Z",
    updatedAt: "2026-02-14T08:20:00.000Z",
    asset: DEFAULT_ASSETS[0],
    annotations: [
      {
        id: "ann-1",
        weedType: "Lantana",
        confidence: "LIKELY",
        coordinates: [
          [1200, 900],
          [1290, 920],
          [1268, 1034],
          [1174, 1010],
        ],
        verified: false,
        pushedToTraining: false,
        pushedAt: null,
      },
      {
        id: "ann-2",
        weedType: "Wattle",
        confidence: "CERTAIN",
        coordinates: [
          [2300, 1300],
          [2375, 1305],
          [2362, 1382],
          [2285, 1370],
        ],
        verified: true,
        verifiedAt: "2026-02-14T08:18:00.000Z",
        pushedToTraining: false,
        pushedAt: null,
      },
    ],
  },
  {
    id: "session-asset-2",
    status: "IN_PROGRESS",
    createdAt: "2026-02-14T09:10:00.000Z",
    updatedAt: "2026-02-14T09:20:00.000Z",
    asset: DEFAULT_ASSETS[1],
    annotations: [],
  },
];

const DEFAULT_SPRAY_PLANS: SprayPlan[] = [
  {
    id: "plan-1",
    name: "North Farm - Morning Sortie",
    status: "READY",
    progress: 100,
    errorMessage: null,
    createdAt: "2026-02-10T08:10:00.000Z",
    project: { id: "proj-1", name: "North Farm Survey", location: "Queensland" },
    _count: { missions: 2, zones: 9 },
  },
];

const DEFAULT_ORTHOMOSAICS: Orthomosaic[] = [
  {
    id: "ortho-1",
    name: "North Field Mosaic",
    description: "Latest stitched GeoTIFF",
    fileSize: 156_002_111,
    centerLat: -27.4667,
    centerLon: 153.0238,
    captureDate: "2026-02-11T00:00:00.000Z",
    resolution: 2.7,
    area: 24.2,
    imageCount: 162,
    status: "COMPLETED",
    createdAt: "2026-02-12T06:45:00.000Z",
    project: { id: "proj-1", name: "North Farm Survey", location: "Queensland" },
    projectId: "proj-1",
    bounds: {
      type: "Polygon",
      coordinates: [
        [
          [153.021, -27.468],
          [153.026, -27.468],
          [153.026, -27.465],
          [153.021, -27.465],
          [153.021, -27.468],
        ],
      ],
    },
    minZoom: 12,
    maxZoom: 22,
  },
];

const DEFAULT_DATASETS: TrainingDataset[] = [
  {
    id: "dataset-1",
    name: "Baseline Weed Set",
    description: "Initial curated set",
    imageCount: 20,
    labelCount: 34,
    trainCount: 14,
    valCount: 4,
    testCount: 2,
    classes: ["Lantana", "Wattle"],
    augmentationPreset: "agricultural",
    augmentationConfig: {
      horizontalFlip: true,
      verticalFlip: true,
      rotation: 15,
      brightness: 25,
      saturation: 20,
      blur: true,
      shadow: true,
      copiesPerImage: 3,
    },
    createdAt: "2026-02-13T05:10:00.000Z",
    project: { id: "proj-1", name: "North Farm Survey" },
  },
];

const DEFAULT_TRAINING_JOBS: TrainingJob[] = [];

const DEFAULT_TRAINED_MODELS: TrainedModel[] = [
  {
    id: "model-1",
    name: "north-farm",
    version: 3,
    displayName: "North Farm v3",
    classes: ["Lantana", "Wattle"],
    mAP50: 0.84,
    mAP5095: 0.61,
    precision: 0.8,
    recall: 0.78,
    f1Score: 0.79,
    classMetrics: {
      Lantana: { precision: 0.82, recall: 0.79, f1: 0.8, mAP50: 0.85, support: 40 },
      Wattle: { precision: 0.77, recall: 0.75, f1: 0.76, mAP50: 0.81, support: 28 },
    },
    status: "ACTIVE",
    isActive: true,
    createdAt: "2026-02-10T00:00:00.000Z",
  },
];

const DEFAULT_INFERENCE_JOBS: InferenceJob[] = [
  {
    id: "inference-1",
    status: "COMPLETED",
    progress: 100,
    createdAt: "2026-02-12T03:00:00.000Z",
    project: { id: "proj-1", name: "North Farm Survey" },
    config: {
      modelId: "model-1",
      modelName: "North Farm v3",
      confidence: 0.25,
      totalImages: 20,
      processedImages: 20,
      detectionsFound: 34,
      skippedImages: 0,
      duplicateImages: 0,
    },
  },
];

const DEFAULT_ROBOFLOW_PROJECTS = [
  {
    project: {
      id: "rf-proj-1",
      roboflowId: "north-farm",
      name: "North Farm Training",
      type: "object-detection",
      imageCount: 142,
      lastSyncedAt: "2026-02-15T01:05:00.000Z",
    },
    classes: [
      { id: "cls-1", className: "Lantana", count: 41, color: "#16a34a" },
      { id: "cls-2", className: "Wattle", count: 29, color: "#eab308" },
    ],
  },
];

function json(route: Route, body: JsonValue, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function nowIso() {
  return new Date().toISOString();
}

function safeReadJson<T>(request: { postDataJSON: () => unknown }): T | null {
  try {
    return request.postDataJSON() as T;
  } catch {
    return null;
  }
}

function toManualConfidence(score?: number): "CERTAIN" | "LIKELY" | "UNCERTAIN" {
  if (typeof score !== "number") return "LIKELY";
  if (score >= 0.85) return "CERTAIN";
  if (score >= 0.6) return "LIKELY";
  return "UNCERTAIN";
}

function cloneReviewItem(item: ReviewItem): ReviewItem {
  return JSON.parse(JSON.stringify(item)) as ReviewItem;
}

export async function setupMockApi(page: Page, options: MockApiOptions = {}) {
  const state = {
    projects: [...(options.projects ?? DEFAULT_PROJECTS)],
    cameraProfiles: [...(options.cameraProfiles ?? DEFAULT_CAMERA_PROFILES)],
    assets: [...(options.assets ?? DEFAULT_ASSETS)],
    detections: [...(options.detections ?? DEFAULT_DETECTIONS)],
    reviewSessions: [...(options.reviewSessions ?? DEFAULT_REVIEW_SESSIONS)],
    reviewItemsBySession: Object.fromEntries(
      Object.entries(options.reviewItemsBySession ?? DEFAULT_REVIEW_ITEMS_BY_SESSION).map(
        ([sessionId, items]) => [sessionId, items.map(cloneReviewItem)]
      )
    ) as Record<string, ReviewItem[]>,
    annotationSessions: [...(options.annotationSessions ?? DEFAULT_ANNOTATION_SESSIONS)].map(
      (session) => ({
        ...session,
        asset: { ...session.asset },
        annotations: [...session.annotations],
      })
    ),
    sprayPlans: [...(options.sprayPlans ?? DEFAULT_SPRAY_PLANS)],
    orthomosaics: [...(options.orthomosaics ?? DEFAULT_ORTHOMOSAICS)],
    datasets: [...(options.datasets ?? DEFAULT_DATASETS)],
    trainingJobs: [...(options.trainingJobs ?? DEFAULT_TRAINING_JOBS)],
    trainedModels: [...(options.trainedModels ?? DEFAULT_TRAINED_MODELS)],
    inferenceJobs: [...(options.inferenceJobs ?? DEFAULT_INFERENCE_JOBS)],
    trainingAvailable: options.trainingAvailable ?? true,
  };

  const normalizeProject = (project: Project) => ({
    ...project,
    description: null,
    createdAt: "2026-02-01T00:00:00.000Z",
    _count: { assets: state.assets.filter((asset) => asset.project.id === project.id).length },
    cameraProfile: state.cameraProfiles.find((profile) => profile.id === project.cameraProfileId) ?? null,
  });

  const buildPreview = (classes?: string[], splitRatio?: { train?: number; val?: number; test?: number }) => {
    const classCounts = new Map<string, number>();

    for (const detection of state.detections) {
      classCounts.set(detection.className, (classCounts.get(detection.className) || 0) + 1);
    }

    for (const session of state.annotationSessions) {
      for (const annotation of session.annotations) {
        classCounts.set(annotation.weedType, (classCounts.get(annotation.weedType) || 0) + 1);
      }
    }

    const availableClasses = Array.from(classCounts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const selectedClasses =
      classes && classes.length > 0
        ? availableClasses.filter((entry) => classes.includes(entry.name))
        : availableClasses;

    const imageCount = Math.max(1, state.assets.length * 6);
    const labelCount = selectedClasses.reduce((sum, entry) => sum + entry.count, 0);
    const trainRatio = Math.max(0, splitRatio?.train ?? 0.7);
    const valRatio = Math.max(0, splitRatio?.val ?? 0.2);
    const testRatio = Math.max(0, splitRatio?.test ?? 0.1);
    const total = trainRatio + valRatio + testRatio || 1;

    const trainCount = Math.round((imageCount * trainRatio) / total);
    const valCount = Math.round((imageCount * valRatio) / total);
    const testCount = Math.max(0, imageCount - trainCount - valCount);

    return {
      imageCount,
      labelCount,
      trainCount,
      valCount,
      testCount,
      classes: selectedClasses.map((entry) => entry.name),
      classCounts: Object.fromEntries(selectedClasses.map((entry) => [entry.name, entry.count])),
      availableClasses,
    };
  };

  const syncReviewSessionStats = (sessionId: string) => {
    const session = state.reviewSessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    const items = state.reviewItemsBySession[sessionId] ?? [];
    const accepted = items.filter((item) => item.status === "accepted").length;
    const rejected = items.filter((item) => item.status === "rejected").length;
    session.itemsAccepted = accepted;
    session.itemsRejected = rejected;
    session.itemsReviewed = accepted + rejected;
    session.assetCount = new Set(items.map((item) => item.assetId)).size;
  };

  const getReviewSession = (sessionId: string) =>
    state.reviewSessions.find((entry) => entry.id === sessionId) ?? null;

  const getSessionItems = (sessionId: string) => state.reviewItemsBySession[sessionId] ?? [];

  for (const session of state.reviewSessions) {
    syncReviewSessionStats(session.id);
  }

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const method = request.method();
    const url = new URL(request.url());
    const path = url.pathname;

    // -------------------------------
    // Auth
    // -------------------------------
    if (path === "/api/auth/session") {
      return json(route, {
        user: { id: "user-1", name: "E2E Tester", email: "e2e@example.com" },
        expires: "2099-01-01T00:00:00.000Z",
      });
    }
    if (path === "/api/auth/providers") {
      return json(route, {
        credentials: { id: "credentials", name: "Credentials", type: "credentials" },
        google: { id: "google", name: "Google", type: "oauth" },
      });
    }
    if (path === "/api/auth/csrf") return json(route, { csrfToken: "mock-token" });
    if (path === "/api/auth/_log") return json(route, {});

    // -------------------------------
    // Projects
    // -------------------------------
    if (path === "/api/projects") {
      if (method === "GET") {
        return json(route, { projects: state.projects.map(normalizeProject) });
      }
      if (method === "POST") {
        const payload = safeReadJson<Partial<Project>>(request);
        const project: Project = {
          id: `proj-${state.projects.length + 1}`,
          name: payload?.name?.toString().trim() || `Project ${state.projects.length + 1}`,
          location: payload?.location?.toString() || null,
          purpose: payload?.purpose?.toString() || "WEED_DETECTION",
          season: payload?.season?.toString() || null,
          cameraProfileId: null,
          activeModelId: null,
          autoInferenceEnabled: true,
          inferenceBackend: "AUTO",
        };
        state.projects.unshift(project);
        return json(route, normalizeProject(project));
      }
    }

    const projectSettingsMatch = path.match(/^\/api\/projects\/([^/]+)\/settings$/);
    if (projectSettingsMatch) {
      const projectId = projectSettingsMatch[1];
      const project = state.projects.find((entry) => entry.id === projectId);
      if (!project) return json(route, { error: "Project not found" }, 404);

      if (method === "PATCH") {
        const payload = safeReadJson<{
          autoInferenceEnabled?: boolean;
          inferenceBackend?: "LOCAL" | "ROBOFLOW" | "AUTO";
          activeModelId?: string | null;
        }>(request);

        if (typeof payload?.autoInferenceEnabled === "boolean") {
          project.autoInferenceEnabled = payload.autoInferenceEnabled;
        }
        if (payload?.inferenceBackend) {
          project.inferenceBackend = payload.inferenceBackend;
        }
        if (payload?.activeModelId !== undefined) {
          project.activeModelId = payload.activeModelId;
        }
      }

      return json(route, {
        project: {
          autoInferenceEnabled: project.autoInferenceEnabled ?? true,
          inferenceBackend: project.inferenceBackend ?? "AUTO",
          activeModelId: project.activeModelId ?? null,
        },
      });
    }

    const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
    if (projectMatch) {
      const project = state.projects.find((entry) => entry.id === projectMatch[1]);
      if (!project) return json(route, { error: "Project not found" }, 404);

      if (method === "GET") {
        return json(route, normalizeProject(project));
      }

      if (method === "PATCH") {
        const payload = safeReadJson<{ cameraProfileId?: string | null; activeModelId?: string | null }>(
          request
        );
        if (payload?.cameraProfileId !== undefined) {
          project.cameraProfileId =
            payload.cameraProfileId && payload.cameraProfileId !== "none" ? payload.cameraProfileId : null;
        }
        if (payload?.activeModelId !== undefined) {
          project.activeModelId = payload.activeModelId;
        }
        return json(route, { project: normalizeProject(project) });
      }

      return json(route, { success: true });
    }

    // -------------------------------
    // Camera profiles
    // -------------------------------
    if (path === "/api/camera-profiles") {
      if (method === "GET") return json(route, { profiles: state.cameraProfiles });
      if (method === "POST") {
        const payload = safeReadJson<Partial<CameraProfile>>(request);
        const profile: CameraProfile = {
          id: `cam-${state.cameraProfiles.length + 1}`,
          name: payload?.name?.toString().trim() || `Camera ${state.cameraProfiles.length + 1}`,
          description: payload?.description?.toString() || null,
          fov: typeof payload?.fov === "number" ? payload.fov : null,
          calibratedFocalLength:
            typeof payload?.calibratedFocalLength === "number" ? payload.calibratedFocalLength : null,
          opticalCenterX: typeof payload?.opticalCenterX === "number" ? payload.opticalCenterX : null,
          opticalCenterY: typeof payload?.opticalCenterY === "number" ? payload.opticalCenterY : null,
        };
        state.cameraProfiles.unshift(profile);
        return json(route, profile);
      }
    }

    const cameraProfileMatch = path.match(/^\/api\/camera-profiles\/([^/]+)$/);
    if (cameraProfileMatch) {
      if (method === "DELETE") {
        state.cameraProfiles = state.cameraProfiles.filter((profile) => profile.id !== cameraProfileMatch[1]);
      }
      return json(route, { success: true });
    }

    // -------------------------------
    // Assets / detections / annotations
    // -------------------------------
    if (path === "/api/assets") {
      const projectId = url.searchParams.get("projectId");
      const assets =
        projectId && projectId !== "all"
          ? state.assets.filter((asset) => asset.project.id === projectId)
          : state.assets;
      return json(route, { assets });
    }

    if (path === "/api/detections/stats") {
      const verified = state.detections.filter((detection) => detection.verified).length;
      const rejected = state.detections.filter((detection) => detection.rejected).length;
      const total = state.detections.length;
      return json(route, {
        stats: {
          total,
          verified,
          rejected,
          pending: Math.max(0, total - verified - rejected),
          byConfidence: {
            high: state.detections.filter((detection) => detection.confidence >= 0.85).length,
            medium: state.detections.filter(
              (detection) => detection.confidence >= 0.6 && detection.confidence < 0.85
            ).length,
            low: state.detections.filter((detection) => detection.confidence < 0.6).length,
          },
        },
      });
    }

    if (path === "/api/detections") return json(route, state.detections);
    if (path === "/api/annotations/export") return json(route, []);

    if (path === "/api/annotations/sessions") {
      if (method === "GET") {
        const assetId = url.searchParams.get("assetId");
        const status = url.searchParams.get("status");

        const sessions = state.annotationSessions.filter((session) => {
          if (assetId && session.asset.id !== assetId) return false;
          if (status && session.status !== status) return false;
          return true;
        });
        return json(route, sessions);
      }

      if (method === "POST") {
        const payload = safeReadJson<{ assetId?: string; forceNewSession?: boolean }>(request);
        const asset = state.assets.find((entry) => entry.id === payload?.assetId);
        if (!asset) return json(route, { error: "Asset not found" }, 404);

        if (!payload?.forceNewSession) {
          const existing = state.annotationSessions.find(
            (session) => session.asset.id === asset.id && session.status === "IN_PROGRESS"
          );
          if (existing) return json(route, existing);
        }

        const session: AnnotationSession = {
          id: `session-${asset.id}-${state.annotationSessions.length + 1}`,
          status: "IN_PROGRESS",
          createdAt: nowIso(),
          updatedAt: nowIso(),
          asset,
          annotations: [],
        };

        state.annotationSessions.unshift(session);
        return json(route, session);
      }
    }

    const annotationSessionMatch = path.match(/^\/api\/annotations\/sessions\/([^/]+)$/);
    if (annotationSessionMatch) {
      const session = state.annotationSessions.find((entry) => entry.id === annotationSessionMatch[1]);
      if (!session) return json(route, { error: "Session not found" }, 404);

      if (method === "GET") return json(route, session);

      if (method === "PATCH") {
        const payload = safeReadJson<{ status?: "IN_PROGRESS" | "COMPLETED" }>(request);
        if (payload?.status) session.status = payload.status;
        session.updatedAt = nowIso();
      }

      return json(route, { success: true, session });
    }

    if (path === "/api/annotations") {
      if (method === "POST") {
        const payload = safeReadJson<{
          sessionId?: string;
          weedType?: string;
          confidence?: "CERTAIN" | "LIKELY" | "UNCERTAIN";
          coordinates?: [number, number][];
          notes?: string;
        }>(request);

        const session = state.annotationSessions.find((entry) => entry.id === payload?.sessionId);
        if (!session) return json(route, { error: "Annotation session not found" }, 404);

        const annotation: ManualAnnotation = {
          id: `ann-${session.annotations.length + 1}-${Math.random().toString(36).slice(2, 6)}`,
          weedType: payload?.weedType || "Lantana",
          confidence: payload?.confidence || "LIKELY",
          coordinates:
            payload?.coordinates && payload.coordinates.length >= 3
              ? payload.coordinates
              : [
                  [1100, 900],
                  [1180, 920],
                  [1160, 1010],
                ],
          notes: payload?.notes,
          verified: false,
          pushedToTraining: false,
          pushedAt: null,
        };

        session.annotations.unshift(annotation);
        session.updatedAt = nowIso();

        return json(route, {
          ...annotation,
          hasGeoCoordinates: true,
        });
      }

      if (method === "GET") {
        const sessionId = url.searchParams.get("sessionId");
        const annotations = state.annotationSessions
          .filter((session) => (sessionId ? session.id === sessionId : true))
          .flatMap((session) => session.annotations);
        return json(route, {
          annotations,
          pagination: {
            page: 1,
            pageSize: 50,
            total: annotations.length,
            totalPages: 1,
            hasMore: false,
          },
        });
      }
    }

    const annotationVerifyMatch = path.match(/^\/api\/annotations\/([^/]+)\/verify$/);
    if (annotationVerifyMatch) {
      const annotationId = annotationVerifyMatch[1];
      for (const session of state.annotationSessions) {
        const annotation = session.annotations.find((entry) => entry.id === annotationId);
        if (annotation) {
          annotation.verified = true;
          annotation.verifiedAt = nowIso();
          session.updatedAt = nowIso();
          return json(route, {
            id: annotation.id,
            verified: annotation.verified,
            verifiedAt: annotation.verifiedAt,
          });
        }
      }
      return json(route, { error: "Annotation not found" }, 404);
    }

    const annotationMatch = path.match(/^\/api\/annotations\/([^/]+)$/);
    if (annotationMatch) {
      const annotationId = annotationMatch[1];
      const session = state.annotationSessions.find((entry) =>
        entry.annotations.some((annotation) => annotation.id === annotationId)
      );
      if (!session) return json(route, { error: "Annotation not found" }, 404);

      const annotation = session.annotations.find((entry) => entry.id === annotationId);
      if (!annotation) return json(route, { error: "Annotation not found" }, 404);

      if (method === "DELETE") {
        session.annotations = session.annotations.filter((entry) => entry.id !== annotationId);
        session.updatedAt = nowIso();
        return json(route, { success: true });
      }

      if (method === "PUT") {
        const payload = safeReadJson<Partial<ManualAnnotation>>(request);
        if (payload?.weedType) annotation.weedType = payload.weedType;
        if (payload?.confidence) annotation.confidence = payload.confidence;
        if (payload?.coordinates && payload.coordinates.length >= 3) {
          annotation.coordinates = payload.coordinates;
        }
        if (typeof payload?.verified === "boolean") {
          annotation.verified = payload.verified;
          annotation.verifiedAt = payload.verified ? nowIso() : null;
        }
        session.updatedAt = nowIso();
        return json(route, annotation as unknown as JsonValue);
      }

      return json(route, annotation as unknown as JsonValue);
    }

    if (path === "/api/roboflow/push-session") {
      if (method !== "POST") return json(route, { error: "Method not allowed" }, 405);
      const payload = safeReadJson<{ sessionId?: string }>(request);
      const session = state.annotationSessions.find((entry) => entry.id === payload?.sessionId);
      if (!session) return json(route, { error: "Session not found" }, 404);

      const toPush = session.annotations.filter((annotation) => annotation.verified && !annotation.pushedToTraining);
      for (const annotation of toPush) {
        annotation.pushedToTraining = true;
        annotation.pushedAt = nowIso();
      }

      return json(route, {
        success: true,
        pushed: toPush.length,
        failed: 0,
        remaining: 0,
        message:
          toPush.length > 0
            ? `Successfully uploaded ${toPush.length} annotations.`
            : "No verified annotations to push",
      });
    }

    // -------------------------------
    // Roboflow
    // -------------------------------
    if (path === "/api/roboflow/models") {
      return json(route, {
        models: [
          {
            id: "rf-model-1",
            projectId: "rf-proj-1",
            projectName: "North Farm Training",
            version: 3,
            type: "object-detection",
            endpoint: "north-farm/3",
            classes: ["Lantana", "Wattle"],
            createdAt: "2026-02-10T00:00:00.000Z",
          },
        ],
      });
    }

    if (path === "/api/roboflow/projects") {
      return json(route, {
        projects: DEFAULT_ROBOFLOW_PROJECTS,
      });
    }

    const roboflowProjectClassesMatch = path.match(/^\/api\/roboflow\/projects\/([^/]+)\/classes$/);
    if (roboflowProjectClassesMatch) {
      const project = DEFAULT_ROBOFLOW_PROJECTS.find((entry) => entry.project.id === roboflowProjectClassesMatch[1]);
      return json(route, { classes: project?.classes || [] });
    }

    if (path === "/api/roboflow/push-session") {
      return json(route, { success: true, pushed: 0, failed: 0, remaining: 0 });
    }

    // -------------------------------
    // SAM3
    // -------------------------------
    if (path === "/api/sam3/batch/all") return json(route, { batchJobs: [] });
    if (path === "/api/sam3/start") return json(route, { success: true, ready: true, starting: false });
    if (path === "/api/sam3/status") {
      return json(route, {
        aws: { configured: true, state: "READY", ready: true, gpuAvailable: true, modelLoaded: true },
        roboflow: { configured: true, ready: true },
        preferredBackend: "aws",
      });
    }
    if (path === "/api/sam3/health") {
      return json(route, {
        available: true,
        mode: "realtime",
        device: "aws-gpu",
        latencyMs: 182,
        backend: "aws",
      });
    }
    if (path === "/api/sam3/concept/status") {
      return json(route, {
        configured: true,
        ready: true,
        sam3Loaded: true,
        dinoLoaded: true,
      });
    }
    if (path === "/api/sam3/predict") {
      const payload = safeReadJson<{ points?: Array<{ x: number; y: number }> }>(request);
      const point = payload?.points?.[0] || { x: 1400, y: 1000 };
      const polygon: [number, number][] = [
        [point.x - 40, point.y - 35],
        [point.x + 44, point.y - 28],
        [point.x + 36, point.y + 42],
        [point.x - 34, point.y + 38],
      ];
      return json(route, {
        success: true,
        polygon,
        score: 0.89,
        backend: "aws",
      });
    }

    // -------------------------------
    // Review workflows
    // -------------------------------
    if (path === "/api/review/queue") return json(route, { sessions: state.reviewSessions });

    if (path === "/api/review") {
      if (method === "GET") return json(route, { sessions: state.reviewSessions });

      if (method === "POST") {
        const payload = safeReadJson<{
          projectId?: string;
          workflowType?: string;
          roboflowProjectId?: string;
          confidenceThreshold?: number;
        }>(request);

        const project = state.projects.find((entry) => entry.id === payload?.projectId) || state.projects[0];
        const sessionId = `review-${state.reviewSessions.length + 1}`;
        const session: ReviewSession = {
          id: sessionId,
          projectId: project.id,
          workflowType: payload?.workflowType || "improve_model",
          assetCount: state.assets.filter((asset) => asset.project.id === project.id).length,
          itemsReviewed: 0,
          itemsAccepted: 0,
          itemsRejected: 0,
          status: "ACTIVE",
          createdAt: nowIso(),
          project: { id: project.id, name: project.name },
          roboflowProjectId: payload?.roboflowProjectId || "north-farm",
          confidenceThreshold:
            typeof payload?.confidenceThreshold === "number" ? payload.confidenceThreshold : 0.5,
          inferenceJobIds: [],
          batchJobIds: [],
          assignedTo: null,
        };

        const sessionAssets = state.assets.filter((asset) => asset.project.id === project.id);
        state.reviewItemsBySession[sessionId] = sessionAssets.map((asset, index) => ({
          id: `${sessionId}-item-${index + 1}`,
          source: "detection",
          sourceId: `det-generated-${index + 1}`,
          assetId: asset.id,
          asset: {
            id: asset.id,
            fileName: asset.fileName,
            storageUrl: asset.storageUrl,
            imageWidth: asset.imageWidth,
            imageHeight: asset.imageHeight,
            gpsLatitude: asset.gpsLatitude,
            gpsLongitude: asset.gpsLongitude,
            altitude: asset.altitude,
            gimbalPitch: asset.gimbalPitch,
            gimbalRoll: asset.gimbalRoll,
            gimbalYaw: asset.gimbalYaw,
          },
          className: index % 2 === 0 ? "Lantana" : "Wattle",
          confidence: index % 2 === 0 ? 0.82 : 0.74,
          geometry: {
            type: "bbox",
            bbox: [1000 + index * 80, 900 + index * 50, 1160 + index * 80, 1080 + index * 50],
          },
          status: "pending",
          correctedClass: null,
          hasGeoData: true,
          warnings: [],
        }));

        syncReviewSessionStats(sessionId);
        state.reviewSessions.unshift(session);

        return json(route, {
          success: true,
          session: {
            id: sessionId,
          },
        });
      }
    }

    const reviewItemsMatch = path.match(/^\/api\/review\/([^/]+)\/items$/);
    if (reviewItemsMatch) {
      const sessionId = reviewItemsMatch[1];
      const session = getReviewSession(sessionId);
      if (!session) return json(route, { error: "Review session not found" }, 404);
      const assetId = url.searchParams.get("assetId");
      const items = getSessionItems(sessionId).filter((item) => (assetId ? item.assetId === assetId : true));
      return json(route, { items });
    }

    const reviewActionMatch = path.match(/^\/api\/review\/([^/]+)\/(assign|action|bulk-action|push)$/);
    if (reviewActionMatch) {
      const sessionId = reviewActionMatch[1];
      const action = reviewActionMatch[2];
      const session = getReviewSession(sessionId);
      if (!session) return json(route, { error: "Review session not found" }, 404);

      if (action === "assign") {
        const payload = safeReadJson<{ assigneeId?: string | null }>(request);
        if (payload?.assigneeId) {
          session.assignedTo = {
            id: payload.assigneeId,
            name: payload.assigneeId === "me" ? "E2E Tester" : payload.assigneeId,
            email: "e2e@example.com",
          };
        } else {
          session.assignedTo = null;
        }
        return json(route, { success: true, session });
      }

      if (action === "action") {
        const payload = safeReadJson<{
          action?: "accept" | "reject" | "correct";
          itemId?: string;
          correctedClass?: string;
        }>(request);

        const item = getSessionItems(sessionId).find((entry) => entry.sourceId === payload?.itemId);
        if (!item) return json(route, { error: "Review item not found" }, 404);

        if (payload?.action === "accept") item.status = "accepted";
        if (payload?.action === "reject") item.status = "rejected";
        if (payload?.action === "correct") {
          item.status = "accepted";
          if (payload.correctedClass) {
            item.correctedClass = payload.correctedClass;
            item.className = payload.correctedClass;
          }
        }

        syncReviewSessionStats(sessionId);
        return json(route, { success: true });
      }

      if (action === "bulk-action") {
        const payload = safeReadJson<{
          action?: "accept" | "reject";
          items?: Array<{ itemId?: string }>;
        }>(request);

        const targets = new Set((payload?.items || []).map((entry) => entry.itemId).filter(Boolean));
        for (const item of getSessionItems(sessionId)) {
          if (!targets.has(item.sourceId)) continue;
          item.status = payload?.action === "reject" ? "rejected" : "accepted";
        }

        syncReviewSessionStats(sessionId);
        return json(route, { success: true });
      }

      if (action === "push") {
        const payload = safeReadJson<{
          target?: "roboflow" | "yolo";
          yoloConfig?: {
            datasetName?: string;
            classes?: string[];
          };
        }>(request);

        if (payload?.target === "yolo") {
          const selectedItems = getSessionItems(sessionId).filter((item) => item.status === "accepted");
          const datasetId = `dataset-${state.datasets.length + 1}`;
          const datasetName = payload?.yoloConfig?.datasetName || `review-${sessionId}`;
          const classes = payload?.yoloConfig?.classes?.length
            ? payload.yoloConfig.classes
            : Array.from(new Set(selectedItems.map((item) => item.className)));

          const dataset: TrainingDataset = {
            id: datasetId,
            name: datasetName,
            description: "Generated from review session",
            imageCount: Math.max(1, selectedItems.length),
            labelCount: selectedItems.length,
            trainCount: Math.max(1, Math.round(selectedItems.length * 0.7)),
            valCount: Math.max(0, Math.round(selectedItems.length * 0.2)),
            testCount: Math.max(0, selectedItems.length - Math.round(selectedItems.length * 0.9)),
            classes,
            augmentationPreset: "agricultural",
            augmentationConfig: null,
            createdAt: nowIso(),
            project: { id: session.project.id, name: session.project.name },
          };
          state.datasets.unshift(dataset);

          const jobId = `train-${state.trainingJobs.length + 1}`;
          const newJob: TrainingJob = {
            id: jobId,
            status: "QUEUED",
            baseModel: "yolo11m",
            epochs: 100,
            batchSize: 16,
            imageSize: 640,
            currentEpoch: 0,
            progress: 0,
            estimatedMinutes: 36,
            startedAt: nowIso(),
            createdAt: nowIso(),
            errorMessage: null,
            dataset: {
              id: dataset.id,
              name: dataset.name,
              imageCount: dataset.imageCount,
              classes: dataset.classes,
            },
            currentMetrics: { mAP50: 0.0, precision: 0.0, recall: 0.0 },
            syncStatus: "ok",
            syncError: null,
            syncUpdatedAt: nowIso(),
          };
          state.trainingJobs.unshift(newJob);

          return json(route, {
            success: true,
            results: { yolo: { trainingJobId: jobId, modelName: "YOLO v1" } },
          });
        }

        return json(route, {
          success: true,
          results: { roboflow: { uploaded: getSessionItems(sessionId).filter((item) => item.status === "accepted").length } },
        });
      }
    }

    const reviewSessionMatch = path.match(/^\/api\/review\/([^/]+)$/);
    if (reviewSessionMatch) {
      const session = getReviewSession(reviewSessionMatch[1]);
      if (!session) return json(route, { error: "Review session not found" }, 404);
      syncReviewSessionStats(session.id);
      return json(route, {
        id: session.id,
        projectId: session.projectId,
        workflowType: session.workflowType,
        assetCount: session.assetCount,
        itemsReviewed: session.itemsReviewed,
        itemsAccepted: session.itemsAccepted,
        itemsRejected: session.itemsRejected,
        roboflowProjectId: session.roboflowProjectId || "north-farm",
        confidenceThreshold: session.confidenceThreshold ?? 0.5,
        inferenceJobIds: session.inferenceJobIds || [],
        batchJobIds: session.batchJobIds || [],
        assignedTo: session.assignedTo || null,
        createdAt: session.createdAt,
      });
    }

    // -------------------------------
    // Training
    // -------------------------------
    if (path === "/api/training/health") {
      if (!state.trainingAvailable) {
        return json(route, {
          available: false,
          error: "YOLO service unavailable",
        });
      }
      return json(route, {
        available: true,
        health: {
          status: "healthy",
          gpu_available: true,
          gpu_name: "NVIDIA T4",
          active_training_jobs: state.trainingJobs.filter((job) =>
            ["QUEUED", "PREPARING", "RUNNING", "UPLOADING"].includes(job.status)
          ).length,
          cached_models: state.trainedModels.map((model) => model.id),
        },
      });
    }

    if (path === "/api/training/datasets/preview") {
      const payload = safeReadJson<{
        classes?: string[];
        splitRatio?: { train?: number; val?: number; test?: number };
      }>(request);
      return json(route, {
        preview: buildPreview(payload?.classes, payload?.splitRatio),
      });
    }

    if (path === "/api/training/datasets") {
      if (method === "GET") {
        return json(route, {
          datasets: state.datasets,
          total: state.datasets.length,
          limit: Number(url.searchParams.get("limit") || "20"),
          offset: Number(url.searchParams.get("offset") || "0"),
        });
      }

      if (method === "POST") {
        const payload = safeReadJson<{
          name?: string;
          description?: string;
          projectId?: string;
          classes?: string[];
          splitRatio?: { train?: number; val?: number; test?: number };
          augmentationPreset?: string;
          augmentationConfig?: Record<string, JsonValue> | null;
        }>(request);

        const project = state.projects.find((entry) => entry.id === payload?.projectId) || state.projects[0];
        const preview = buildPreview(payload?.classes, payload?.splitRatio);
        const dataset: TrainingDataset = {
          id: `dataset-${state.datasets.length + 1}`,
          name: payload?.name?.trim() || `Dataset ${state.datasets.length + 1}`,
          description: payload?.description || null,
          imageCount: preview.imageCount,
          labelCount: preview.labelCount,
          trainCount: preview.trainCount,
          valCount: preview.valCount,
          testCount: preview.testCount,
          classes: preview.classes,
          augmentationPreset: payload?.augmentationPreset || "agricultural",
          augmentationConfig: payload?.augmentationConfig || null,
          createdAt: nowIso(),
          project: { id: project.id, name: project.name },
        };
        state.datasets.unshift(dataset);

        return json(route, {
          success: true,
          dataset,
        });
      }
    }

    if (path === "/api/training/jobs") {
      if (method === "GET") {
        return json(route, {
          jobs: state.trainingJobs,
          total: state.trainingJobs.length,
          limit: Number(url.searchParams.get("limit") || "20"),
          offset: Number(url.searchParams.get("offset") || "0"),
        });
      }

      if (method === "POST") {
        const payload = safeReadJson<{
          datasetId?: string;
          baseModel?: string;
          epochs?: number;
          batchSize?: number;
          imageSize?: number;
        }>(request);

        const dataset = state.datasets.find((entry) => entry.id === payload?.datasetId);
        if (!dataset) {
          return json(route, { error: "Dataset not found" }, 404);
        }

        const job: TrainingJob = {
          id: `train-${state.trainingJobs.length + 1}`,
          status: "QUEUED",
          baseModel: payload?.baseModel || "yolo11m",
          epochs: payload?.epochs || 100,
          batchSize: payload?.batchSize || 16,
          imageSize: payload?.imageSize || 640,
          currentEpoch: 0,
          progress: 0,
          estimatedMinutes: Math.max(12, Math.round((payload?.epochs || 100) * 0.4)),
          startedAt: nowIso(),
          createdAt: nowIso(),
          errorMessage: null,
          dataset: {
            id: dataset.id,
            name: dataset.name,
            imageCount: dataset.imageCount,
            classes: dataset.classes,
          },
          currentMetrics: {
            mAP50: 0.02,
            precision: 0.03,
            recall: 0.02,
          },
          syncStatus: "ok",
          syncError: null,
          syncUpdatedAt: nowIso(),
        };

        state.trainingJobs.unshift(job);

        return json(route, {
          success: true,
          job,
        });
      }
    }

    const trainingJobMetricsMatch = path.match(/^\/api\/training\/jobs\/([^/]+)\/metrics$/);
    if (trainingJobMetricsMatch) {
      const job = state.trainingJobs.find((entry) => entry.id === trainingJobMetricsMatch[1]);
      if (!job) return json(route, { history: [] });
      const currentEpoch = Math.max(1, job.currentEpoch || 1);
      const history = Array.from({ length: Math.min(currentEpoch, 8) }, (_, index) => {
        const epoch = index + 1;
        return {
          epoch,
          mAP50: Math.min(0.92, 0.12 + epoch * 0.05),
          mAP5095: Math.min(0.78, 0.08 + epoch * 0.04),
          precision: Math.min(0.9, 0.2 + epoch * 0.05),
          recall: Math.min(0.88, 0.18 + epoch * 0.05),
          box_loss: Math.max(0.08, 1.2 - epoch * 0.1),
          cls_loss: Math.max(0.05, 0.9 - epoch * 0.08),
        };
      });
      return json(route, { history });
    }

    const trainingJobMatch = path.match(/^\/api\/training\/jobs\/([^/]+)$/);
    if (trainingJobMatch) {
      const job = state.trainingJobs.find((entry) => entry.id === trainingJobMatch[1]);
      if (!job) return json(route, { error: "Training job not found" }, 404);

      if (method === "DELETE") {
        if (["QUEUED", "PREPARING", "RUNNING", "UPLOADING"].includes(job.status)) {
          job.status = "CANCELLED";
          job.errorMessage = "Cancelled by user";
        }
        return json(route, { success: true, job });
      }

      if (job.status === "QUEUED") {
        job.status = "RUNNING";
        job.currentEpoch = 2;
        job.progress = 0.18;
        job.currentMetrics = {
          mAP50: 0.24,
          precision: 0.31,
          recall: 0.27,
        };
      }

      return json(route, job as unknown as JsonValue);
    }

    const trainingModelActionMatch = path.match(/^\/api\/training\/models\/([^/]+)\/(activate|download)$/);
    if (trainingModelActionMatch) {
      const modelId = trainingModelActionMatch[1];
      const action = trainingModelActionMatch[2];

      if (action === "activate") {
        const payload = safeReadJson<{ projectId?: string }>(request);
        const project = state.projects.find((entry) => entry.id === payload?.projectId) || state.projects[0];
        project.activeModelId = modelId;
        state.trainedModels = state.trainedModels.map((model) => ({
          ...model,
          isActive: model.id === modelId,
        }));
        return json(route, { success: true });
      }

      return json(route, {
        success: true,
        url: `https://example.test/models/${modelId}.pt`,
      });
    }

    if (path === "/api/training/models") {
      const projectId = url.searchParams.get("projectId");
      const project = projectId ? state.projects.find((entry) => entry.id === projectId) : null;
      const activeModelId = project?.activeModelId ?? null;

      const models = state.trainedModels.map((model) => ({
        ...model,
        isActive: activeModelId ? model.id === activeModelId : model.isActive,
      }));

      return json(route, {
        models,
        total: models.length,
        limit: Number(url.searchParams.get("limit") || "20"),
        offset: Number(url.searchParams.get("offset") || "0"),
        activeModelId,
      });
    }

    // -------------------------------
    // Inference
    // -------------------------------
    if (path === "/api/inference/jobs") {
      return json(route, {
        jobs: state.inferenceJobs,
        total: state.inferenceJobs.length,
      });
    }

    if (path === "/api/inference/run") {
      const payload = safeReadJson<{
        preview?: boolean;
        projectId?: string;
        modelId?: string;
        confidence?: number;
      }>(request);

      const project = state.projects.find((entry) => entry.id === payload?.projectId) || state.projects[0];
      if (payload?.preview) {
        return json(route, {
          totalImages: Math.max(1, state.assets.filter((asset) => asset.project.id === project.id).length),
          skippedImages: 0,
          duplicateImages: 0,
        });
      }

      const model = state.trainedModels.find((entry) => entry.id === payload?.modelId) || state.trainedModels[0];
      const job: InferenceJob = {
        id: `inference-${state.inferenceJobs.length + 1}`,
        status: "PENDING",
        progress: 0,
        createdAt: nowIso(),
        project: { id: project.id, name: project.name },
        config: {
          modelId: model?.id,
          modelName: model?.displayName || `${model?.name || "model"} v${model?.version || 1}`,
          confidence: payload?.confidence ?? 0.25,
          totalImages: state.assets.filter((asset) => asset.project.id === project.id).length,
          processedImages: 0,
          detectionsFound: 0,
          skippedImages: 0,
          duplicateImages: 0,
        },
      };
      state.inferenceJobs.unshift(job);
      return json(route, { job });
    }

    const inferenceJobMatch = path.match(/^\/api\/inference\/([^/]+)$/);
    if (inferenceJobMatch) {
      const job = state.inferenceJobs.find((entry) => entry.id === inferenceJobMatch[1]);
      if (!job) return json(route, { error: "Inference job not found" }, 404);
      if (method === "DELETE") {
        job.status = "CANCELLED";
        return json(route, { success: true });
      }
      return json(route, { success: true, job });
    }

    if (path === "/api/inference/health") {
      return json(route, { available: true, status: "healthy" });
    }

    // -------------------------------
    // Spray plans / compliance / orthomosaics
    // -------------------------------
    if (path === "/api/spray-plans") {
      if (method === "GET") return json(route, { plans: state.sprayPlans });
      if (method === "POST") {
        const payload = safeReadJson<{ name?: string; projectId?: string }>(request);
        const project = state.projects.find((entry) => entry.id === payload?.projectId) ?? state.projects[0];
        const plan: SprayPlan = {
          id: `plan-${state.sprayPlans.length + 1}`,
          name: payload?.name || `Generated Plan ${state.sprayPlans.length + 1}`,
          status: "READY",
          progress: 100,
          errorMessage: null,
          createdAt: nowIso(),
          project: { id: project.id, name: project.name, location: project.location },
          _count: { missions: 1, zones: 4 },
        };
        state.sprayPlans.unshift(plan);
        return json(route, { planId: plan.id });
      }
    }

    const sprayPlanMatch = path.match(/^\/api\/spray-plans\/([^/]+)$/);
    if (sprayPlanMatch) {
      const plan = state.sprayPlans.find((entry) => entry.id === sprayPlanMatch[1]) ?? state.sprayPlans[0];
      return json(route, {
        id: plan.id,
        name: plan.name,
        status: plan.status,
        progress: plan.progress,
        errorMessage: plan.errorMessage,
        summary: {},
        project: plan.project,
        zones: [],
        missions: [],
      });
    }

    if (path === "/api/compliance-layers") {
      if (method === "GET") return json(route, { layers: [] });
      return json(route, { id: "layer-1" });
    }

    const complianceLayerMatch = path.match(/^\/api\/compliance-layers\/([^/]+)$/);
    if (complianceLayerMatch) return json(route, { success: true });

    if (path === "/api/orthomosaics") return json(route, { orthomosaics: state.orthomosaics });

    const orthomosaicMatch = path.match(/^\/api\/orthomosaics\/([^/]+)$/);
    if (orthomosaicMatch) {
      const orthomosaic =
        state.orthomosaics.find((entry) => entry.id === orthomosaicMatch[1]) ?? state.orthomosaics[0];
      return json(route, orthomosaic);
    }

    // -------------------------------
    // Utilities
    // -------------------------------
    if (path === "/api/check-gps") {
      return json(route, {
        total: state.assets.length,
        withGPS: { count: state.assets.length, assets: state.assets },
        withoutGPS: { count: 0, assets: [] },
      });
    }

    if (path === "/api/add-sample-gps") return json(route, { success: true });

    if (path === "/api/export/stream") {
      return route.fulfill({
        status: 200,
        contentType: "application/zip",
        body: "mock-export",
        headers: { "content-disposition": 'attachment; filename="weed-detections.zip"' },
      });
    }

    if (path.startsWith("/api/s3/multipart/")) return json(route, {});

    if (path === "/api/upload") {
      return json(route, {
        message: "Processed",
        files: [],
      });
    }

    if (method === "GET") return json(route, {});
    if (method === "DELETE") return json(route, { success: true });
    return json(route, { success: true });
  });
}
