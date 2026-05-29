"use client";

import { useCallback, useEffect, useMemo, useState, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertCircle,
  ArrowRight,
  Brain,
  CheckCircle2,
  Clock,
  Eye,
  Images,
  Loader2,
  Map,
  Settings,
  ShieldCheck,
  Tags,
  Upload,
} from "lucide-react";
import { UppyUploader, type UploadApiResponse } from "@/components/UppyUploader";
import { ModelSelector, type RoboflowModel } from "@/components/detection/ModelSelector";

interface Project {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
  cameraProfileId?: string | null;
  activeModelId?: string | null;
  autoInferenceEnabled?: boolean;
  inferenceBackend?: "LOCAL" | "ROBOFLOW" | "AUTO" | null;
  _count?: { assets: number };
}

interface CameraProfile {
  id: string;
  name: string;
  description?: string | null;
  fov?: number | null;
  fovScale?: number | null;
  altitudeScale?: number | null;
  yawOffsetDeg?: number | null;
  calibratedFocalLength?: number | null;
  opticalCenterX?: number | null;
  opticalCenterY?: number | null;
}

interface TrainedModel {
  id: string;
  name: string;
  version: number;
  displayName?: string | null;
  status: string;
  isActive?: boolean;
  classes?: string[];
  mAP50?: number | null;
}

type UploadMode = "upload-only" | "run-active";

const READY_MODEL_STATUSES = new Set(["READY", "ACTIVE"]);

function getModelLabel(model: TrainedModel | null): string {
  if (!model) return "No active model";
  const name = model.displayName || model.name;
  return /yolo/i.test(name) ? `${name} v${model.version}` : `${name} YOLO11 v${model.version}`;
}

function formatClassName(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function getDetectionIntentLabel(model: TrainedModel | null): string {
  if (!model) return "Upload and run active model";

  const classes = (model.classes || []).map(formatClassName).filter(Boolean);
  const hasSaplingClass = classes.some((className) =>
    /pine|sapling/.test(className)
  );

  if (hasSaplingClass) return "Upload and find pine saplings";
  if (classes.length === 1) return `Upload and find ${classes[0]}`;
  return "Upload and run active model";
}

function getAutoInferenceJobIds(response: UploadApiResponse | null): string[] {
  const summary = response?.autoInference;
  if (!summary) return [];
  if (summary.jobIds && summary.jobIds.length > 0) return summary.jobIds;
  return summary.jobId ? [summary.jobId] : [];
}

async function getApiErrorMessage(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error || fallback;
}

function UploadPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectParam = searchParams.get("project");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [flightSession, setFlightSession] = useState<string>("");
  const [cameraProfiles, setCameraProfiles] = useState<CameraProfile[]>([]);
  const [selectedCameraProfileId, setSelectedCameraProfileId] = useState<string>("none");
  const [cameraFovInput, setCameraFovInput] = useState<string>("");
  const [uploadMode, setUploadMode] = useState<UploadMode>("upload-only");
  const [runDetection, setRunDetection] = useState<boolean>(false);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<RoboflowModel[]>([]);
  const [activeModel, setActiveModel] = useState<TrainedModel | null>(null);
  const [activeModelLoading, setActiveModelLoading] = useState<boolean>(false);
  const [activeModelError, setActiveModelError] = useState<string | null>(null);
  const [processing, setProcessing] = useState<boolean>(false);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [reviewStarting, setReviewStarting] = useState<boolean>(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [projectsError, setProjectsError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [cameraProfilesError, setCameraProfilesError] = useState<string | null>(null);
  const [uploadResponse, setUploadResponse] = useState<UploadApiResponse | null>(
    null,
  );

  const parsedCameraFov = Number(cameraFovInput);
  const cameraFov =
    cameraFovInput.trim().length > 0 && Number.isFinite(parsedCameraFov)
      ? parsedCameraFov
      : undefined;
  const selectedProjectData = useMemo(
    () => projects.find((project) => project.id === selectedProject) || null,
    [projects, selectedProject]
  );
  const activeModelReady = Boolean(
    activeModel && READY_MODEL_STATUSES.has(activeModel.status)
  );
  const runActiveModel = uploadMode === "run-active" && !runDetection;
  const selectedModelsData = availableModels.filter((model) =>
    selectedModelIds.includes(model.id)
  );
  const advancedDetectionReady = !runDetection || selectedModelsData.length > 0;

  useEffect(() => {
    const loadProjects = async () => {
      setProjectsError(null);
      try {
        const response = await fetch("/api/projects");
        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response, "Failed to load projects"));
        }

        const data = await response.json();
        const projectList = data.projects || [];
        setProjects(projectList);
        if (projectParam && projectList.some((project: Project) => project.id === projectParam)) {
          setSelectedProject(projectParam);
        } else if (projectList.length > 0) {
          setSelectedProject((current) => current || projectList[0].id);
        }
      } catch (error) {
        console.error("Failed to load projects:", error);
        setProjectsError(error instanceof Error ? error.message : "Unable to load projects.");
      }
    };

    void loadProjects();
  }, [projectParam]);

  useEffect(() => {
    const loadCameraProfiles = async () => {
      setCameraProfilesError(null);
      try {
        const response = await fetch("/api/camera-profiles");
        if (!response.ok) {
          throw new Error(
            await getApiErrorMessage(response, "Failed to load camera profiles")
          );
        }
        const data = await response.json();
        setCameraProfiles(data.profiles || []);
      } catch (error) {
        console.error("Failed to load camera profiles:", error);
        setCameraProfilesError(
          error instanceof Error ? error.message : "Unable to load camera profiles."
        );
      }
    };

    void loadCameraProfiles();
  }, []);

  useEffect(() => {
    if (!selectedProject) return;
    const project = projects.find((p) => p.id === selectedProject);
    if (project?.cameraProfileId) {
      setSelectedCameraProfileId(project.cameraProfileId);
    } else {
      setSelectedCameraProfileId("none");
    }
  }, [projects, selectedProject]);

  useEffect(() => {
    setActiveModel(null);
    setActiveModelError(null);

    if (!selectedProjectData) {
      setUploadMode("upload-only");
      setActiveModelLoading(false);
      return;
    }

    if (!selectedProjectData.activeModelId) {
      setUploadMode("upload-only");
      setActiveModelLoading(false);
      return;
    }

    const controller = new AbortController();

    const loadActiveModel = async () => {
      setActiveModelLoading(true);
      try {
        const response = await fetch(
          `/api/training/models?projectId=${encodeURIComponent(selectedProjectData.id)}&limit=50`,
          { signal: controller.signal }
        );
        if (!response.ok) {
          throw new Error(await getApiErrorMessage(response, "Failed to load active model"));
        }

        const data = await response.json();
        const models = Array.isArray(data.models) ? (data.models as TrainedModel[]) : [];
        const activeModelId =
          typeof data.activeModelId === "string"
            ? data.activeModelId
            : selectedProjectData.activeModelId;
        const nextActiveModel =
          models.find((model) => model.id === activeModelId || model.isActive) || null;

        setActiveModel(nextActiveModel);
        setUploadMode(
          selectedProjectData.autoInferenceEnabled && nextActiveModel
            ? "run-active"
            : "upload-only"
        );
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load active model:", error);
        setActiveModelError(
          error instanceof Error ? error.message : "Unable to load the active model."
        );
        setUploadMode("upload-only");
      } finally {
        setActiveModelLoading(false);
      }
    };

    void loadActiveModel();

    return () => controller.abort();
  }, [selectedProjectData]);

  const handleProcessingStart = useCallback(() => {
    setProcessing(true);
    setProcessingError(null);
    setUploadResponse(null);
  }, []);

  const handleProcessingComplete = useCallback((response: UploadApiResponse) => {
    setUploadResponse(response);
    setProcessing(false);
  }, []);

  const handleProcessingError = useCallback((error: Error) => {
    setProcessing(false);
    setProcessingError(error.message);
    setUploadResponse(null);
  }, []);

  const handleModelsLoaded = useCallback((models: RoboflowModel[]) => {
    setAvailableModels(models);
  }, []);

  const handleModelsError = useCallback((message: string | null) => {
    setModelsError(message);
  }, []);

  const handleAdvancedFallbackChange = useCallback((checked: boolean) => {
    setRunDetection(checked);
    if (checked) {
      setUploadMode("upload-only");
    }
  }, []);

  const handleStartReview = useCallback(async () => {
    const inferenceJobIds = getAutoInferenceJobIds(uploadResponse);
    if (!selectedProject || inferenceJobIds.length === 0) return;

    setReviewStarting(true);
    setReviewError(null);
    try {
      const response = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProject,
          workflowType: "yolo_inference",
          targetType: "both",
          inferenceJobIds,
          confidenceThreshold: 0.25,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create review session");
      }

      const sessionId = data?.session?.id;
      if (!sessionId) {
        throw new Error("Review session missing from response");
      }

      router.push(`/review?sessionId=${sessionId}`);
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : "Failed to open review."
      );
    } finally {
      setReviewStarting(false);
    }
  }, [router, selectedProject, uploadResponse]);

  const uploadDisabled =
    !selectedProject ||
    (runActiveModel && !activeModelReady) ||
    !advancedDetectionReady;
  const activeModelName = getModelLabel(activeModel);
  const detectionIntentLabel = getDetectionIntentLabel(activeModel);
  const activeModelBackend = selectedProjectData?.inferenceBackend || "AUTO";
  const autoInferenceJobIds = getAutoInferenceJobIds(uploadResponse);
  const autoInference = uploadResponse?.autoInference;
  const successfulUploadCount =
    uploadResponse?.files.filter((file) => file.success !== false).length || 0;
  const firstUploadedAssetId = uploadResponse?.files.find(
    (file) => file.success !== false && file.id
  )?.id;
  const imagesHref = selectedProject ? `/images?project=${selectedProject}` : "/images";
  const annotateHref = firstUploadedAssetId
    ? `/annotate/${firstUploadedAssetId}`
    : imagesHref;

  return (
    <div className="p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
          <Card>
            <CardHeader className="space-y-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <CardTitle className="text-2xl">Upload Images</CardTitle>
                  <CardDescription>
                    Pick a project, choose whether to run its active model, then upload.
                    Anything the model finds waits for review.
                  </CardDescription>
                </div>
                <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900 lg:max-w-sm">
                  <p className="font-semibold">Safe default</p>
                  <p className="mt-1 text-emerald-800">
                    Uploads finish before inference starts. Candidate detections are never
                    approved automatically.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  {
                    label: "Upload",
                    description: "Store the images first",
                    icon: Upload,
                  },
                  {
                    label: "Run model",
                    description: "Optional background job",
                    icon: Brain,
                  },
                  {
                    label: "Review",
                    description: "Approve before counts/export",
                    icon: Eye,
                  },
                ].map((step, index) => {
                  const StepIcon = step.icon;
                  return (
                    <div
                      key={step.label}
                      className="flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-slate-700">
                        <StepIcon className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                          Step {index + 1}
                        </p>
                        <p className="text-sm font-medium text-slate-900">{step.label}</p>
                        <p className="text-xs text-slate-500">{step.description}</p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </CardHeader>

            <CardContent className="space-y-6">
              {(projectsError || modelsError || cameraProfilesError || activeModelError || reviewError) && (
                <div className="space-y-2">
                  {projectsError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <AlertCircle className="h-4 w-4" />
                      <span>{projectsError}</span>
                    </div>
                  )}
                  {modelsError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <AlertCircle className="h-4 w-4" />
                      <span>{modelsError}</span>
                    </div>
                  )}
                  {cameraProfilesError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <AlertCircle className="h-4 w-4" />
                      <span>{cameraProfilesError}</span>
                    </div>
                  )}
                  {activeModelError && (
                    <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <AlertCircle className="h-4 w-4" />
                      <span>{activeModelError}</span>
                    </div>
                  )}
                  {reviewError && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                      <AlertCircle className="h-4 w-4" />
                      <span>{reviewError}</span>
                    </div>
                  )}
                </div>
              )}
              <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,360px)]">
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="mb-4">
                    <h3 className="text-base font-semibold text-slate-900">1. Choose project</h3>
                    <p className="text-sm text-slate-500">
                      The project controls the active model and keeps uploads organized.
                    </p>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="project">Project</Label>
                      <Select
                        value={selectedProject}
                        onValueChange={setSelectedProject}
                      >
                        <SelectTrigger id="project">
                          <SelectValue placeholder="Choose a project" />
                        </SelectTrigger>
                        <SelectContent>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                              {project.location ? ` - ${project.location}` : ""}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="flightSession">Flight session</Label>
                      <Input
                        id="flightSession"
                        placeholder="e.g. Morning Survey A"
                        value={flightSession}
                        onChange={(event) => setFlightSession(event.target.value)}
                      />
                      <p className="text-xs text-gray-500">
                        Optional. Used to group this upload batch.
                      </p>
                    </div>
                  </div>

                  {projects.length === 0 && (
                    <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                      <p className="mb-2 font-medium">No projects found</p>
                      <p className="mb-3 text-xs text-amber-800">
                        Create a project first so we can organize your uploads.
                      </p>
                      <Link href="/projects">
                        <Button size="sm" variant="outline">
                          Create Project
                        </Button>
                      </Link>
                    </div>
                  )}
                </div>

                <div
                  className={`rounded-lg border p-4 ${
                    activeModelReady
                      ? "border-emerald-200 bg-emerald-50"
                      : "border-amber-200 bg-amber-50"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        This project will use
                      </p>
                      <p className="mt-1 text-lg font-semibold text-slate-950">
                        {activeModelName}
                      </p>
                      <p className="mt-1 text-xs text-slate-600">
                        Backend: {activeModelBackend}
                      </p>
                    </div>
                    {activeModelLoading ? (
                      <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
                    ) : (
                      <ShieldCheck
                        className={`h-6 w-6 ${activeModelReady ? "text-emerald-600" : "text-amber-500"}`}
                      />
                    )}
                  </div>
                  {!activeModelReady && selectedProjectData?.activeModelId ? (
                    <p className="mt-3 rounded-md border border-amber-300 bg-white/70 px-3 py-2 text-xs text-amber-900">
                      The active model is set but not ready yet. Upload only is still safe.
                    </p>
                  ) : null}
                  {!selectedProjectData?.activeModelId ? (
                    <p className="mt-3 rounded-md border border-amber-300 bg-white/70 px-3 py-2 text-xs text-amber-900">
                      No active model is set for this project. Upload only is available, or use
                      the advanced fallback below.
                    </p>
                  ) : null}
                  {activeModelReady ? (
                    <p className="mt-3 text-sm text-emerald-900">
                      Operators can run this model after upload. Results go to review as pending
                      candidates.
                    </p>
                  ) : null}
                </div>
              </section>

              <details className="rounded-lg border border-slate-200 bg-white">
                <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-semibold text-slate-900 hover:bg-slate-50">
                  <Settings className="h-4 w-4 text-slate-500" />
                  Advanced capture settings
                </summary>
                <div className="grid gap-4 border-t border-slate-200 p-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="cameraProfile">Camera profile</Label>
                    <Select
                      value={selectedCameraProfileId}
                      onValueChange={setSelectedCameraProfileId}
                    >
                      <SelectTrigger id="cameraProfile">
                        <SelectValue placeholder="Choose a camera profile" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">No profile (use metadata)</SelectItem>
                        {cameraProfiles.map((profile) => (
                          <SelectItem key={profile.id} value={profile.id}>
                            {profile.name}
                            {profile.fov ? ` - ${profile.fov}°` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">
                      Applies calibrated focal length and optical center from DJI metadata.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="cameraFov">Camera FOV override</Label>
                    <Input
                      id="cameraFov"
                      type="number"
                      min={1}
                      max={180}
                      step="0.1"
                      placeholder="e.g. 84"
                      value={cameraFovInput}
                      onChange={(event) => setCameraFovInput(event.target.value)}
                    />
                    <p className="text-xs text-gray-500">
                      Only use this when DJI metadata is missing or known to be wrong.
                    </p>
                  </div>
                </div>
              </details>

              <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                <div className="mb-4">
                  <h3 className="text-base font-semibold text-slate-900">
                    2. Choose upload action
                  </h3>
                  <p className="text-sm text-slate-500">
                    Most operators only need one of these two choices.
                  </p>
                </div>
                <div className="grid gap-3 md:grid-cols-2">
                  <button
                    type="button"
                    className={`flex min-h-[118px] w-full items-start gap-2 rounded-lg border bg-white p-3 text-left transition sm:gap-3 sm:p-4 ${
                      uploadMode === "upload-only"
                        ? "border-slate-900 ring-2 ring-slate-200"
                        : "border-slate-200 hover:border-slate-300"
                    }`}
                    onClick={() => setUploadMode("upload-only")}
                  >
                    <Upload className="mt-1 h-5 w-5 shrink-0 text-slate-700" />
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-950">
                        Upload images only
                      </span>
                      <span className="mt-1 block text-sm text-slate-600">
                        Safest choice when you only want the files stored and organized.
                      </span>
                    </span>
                    {uploadMode === "upload-only" ? (
                      <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-slate-900" />
                    ) : null}
                  </button>

                  <button
                    type="button"
                    className={`flex min-h-[118px] w-full items-start gap-2 rounded-lg border bg-white p-3 text-left transition sm:gap-3 sm:p-4 ${
                      uploadMode === "run-active"
                        ? "border-emerald-500 ring-2 ring-emerald-100"
                        : "border-slate-200 hover:border-emerald-300"
                    } ${
                      !selectedProjectData?.activeModelId
                        ? "cursor-not-allowed opacity-60"
                        : ""
                    }`}
                    onClick={() => {
                      setRunDetection(false);
                      setUploadMode("run-active");
                    }}
                    disabled={!selectedProjectData?.activeModelId}
                  >
                    <Brain className="mt-1 h-5 w-5 shrink-0 text-emerald-700" />
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-950">
                        {detectionIntentLabel}
                      </span>
                      <span className="mt-1 block text-sm text-slate-600">
                        Runs after upload and sends all detections to review.
                      </span>
                    </span>
                    {uploadMode === "run-active" ? (
                      <CheckCircle2 className="ml-auto h-5 w-5 shrink-0 text-emerald-600" />
                    ) : null}
                  </button>
                </div>
                <p className="mt-3 text-xs text-slate-500">
                  Upload always completes first. Model runs are retryable, and detections stay
                  pending until review accepts them.
                </p>
              </section>

              <details
                className="rounded-lg border border-slate-200 bg-white"
                open={Boolean(selectedProjectData && !selectedProjectData.activeModelId)}
              >
                <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-semibold text-slate-900 hover:bg-slate-50">
                  <Settings className="h-4 w-4 text-slate-500" />
                  Advanced model fallback
                </summary>
                <div className="space-y-4 border-t border-slate-200 p-4">
                  <p className="text-sm text-slate-600">
                    Use this only when the project does not have an active model, or when a
                    specialist needs to run a Roboflow/dynamic model for comparison.
                  </p>
                  <div className="flex items-center space-x-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                    <Checkbox
                      id="runDetection"
                      checked={runDetection}
                      onCheckedChange={(checked) =>
                        handleAdvancedFallbackChange(Boolean(checked))
                      }
                    />
                    <Label
                      htmlFor="runDetection"
                      className="flex cursor-pointer items-center text-sm"
                    >
                      <Brain className="mr-2 h-4 w-4 text-slate-600" />
                      Use Roboflow/dynamic models for this upload
                    </Label>
                  </div>

                  {runDetection && (
                    <ModelSelector
                      selectedModels={selectedModelIds}
                      onSelectionChange={setSelectedModelIds}
                      onModelsLoaded={handleModelsLoaded}
                      onLoadError={handleModelsError}
                      disabled={!selectedProject}
                    />
                  )}
                </div>
              </details>

              {!selectedProject && (
                <div className="flex items-center space-x-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>Select a project to enable uploads.</span>
                </div>
              )}

              {runActiveModel && !activeModelReady && selectedProject && (
                <div className="flex items-center space-x-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>The active model must be ready before it can run after upload.</span>
                </div>
              )}

              {!advancedDetectionReady && (
                <div className="flex items-center space-x-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>Select a fallback model or turn off the advanced fallback.</span>
                </div>
              )}

              <section className="rounded-lg border border-dashed border-gray-300 bg-white p-4">
                <div className="mb-4 flex items-center justify-between">
                  <div>
                    <h3 className="flex items-center text-lg font-semibold">
                      <Upload className="mr-2 h-4 w-4 text-green-600" />
                      3. Drop drone images here
                    </h3>
                    <p className="text-sm text-gray-500">
                      Files are saved first. If you chose a model run, it starts after the
                      upload batch is complete.
                    </p>
                  </div>
                </div>
                <UppyUploader
                  projectId={selectedProject || null}
                  runActiveModel={runActiveModel}
                  runDetection={runDetection}
                  dynamicModels={selectedModelsData}
                  flightSession={flightSession}
                  cameraFov={cameraFov}
                  cameraProfileId={
                    selectedCameraProfileId !== "none" ? selectedCameraProfileId : undefined
                  }
                  disabled={uploadDisabled}
                  onProcessingStart={handleProcessingStart}
                  onProcessingComplete={handleProcessingComplete}
                  onProcessingError={handleProcessingError}
                />
              </section>

              {processing && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                  Saving uploaded files first. Model inference will start after the uploaded
                  assets are saved.
                </div>
              )}

              {processingError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {processingError}
                </div>
              )}

              {uploadResponse && uploadResponse.files.length > 0 && (
                <>
                  {/* Success Banner */}
                  <div className="rounded-lg border border-green-200 bg-green-50 p-4">
                    <div className="flex items-center gap-3">
                      <CheckCircle2 className="h-6 w-6 text-green-600" />
                      <div>
                        <h3 className="font-semibold text-green-800">
                          Upload Complete!
                        </h3>
                        <p className="text-sm text-green-700">
                          {successfulUploadCount} of {uploadResponse.files.length} images uploaded successfully
                        </p>
                      </div>
                    </div>
                  </div>

                  {autoInference && (
                    <div
                      className={`rounded-lg border p-4 text-sm ${
                        autoInference.started
                          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                          : "border-amber-200 bg-amber-50 text-amber-900"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="font-semibold">
                            {autoInference.started
                              ? autoInference.status === "queued"
                                ? "Active model queued"
                                : "Active model completed"
                              : "Active model not started"}
                          </p>
                          <p className="mt-1">
                            {autoInference.error ||
                              "YOLO boxes and georeferenced centres were saved as review-gated candidates."}
                          </p>
                        </div>
                        {autoInference.status === "queued" ? (
                          <Clock className="h-5 w-5" />
                        ) : (
                          <CheckCircle2 className="h-5 w-5" />
                        )}
                      </div>
                      <div className="mt-4 grid gap-2 sm:grid-cols-3">
                        <div className="rounded-md bg-white/70 p-3">
                          <p className="text-xs font-medium uppercase text-slate-500">
                            Images processed
                          </p>
                          <p className="mt-1 text-xl font-semibold">
                            {(autoInference.processedImages ?? autoInference.totalImages ?? 0).toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-md bg-white/70 p-3">
                          <p className="text-xs font-medium uppercase text-slate-500">
                            Skipped
                          </p>
                          <p className="mt-1 text-xl font-semibold">
                            {(autoInference.skippedImages || 0).toLocaleString()}
                          </p>
                        </div>
                        <div className="rounded-md bg-white/70 p-3">
                          <p className="text-xs font-medium uppercase text-slate-500">
                            Candidate detections
                          </p>
                          <p className="mt-1 text-xl font-semibold">
                            {typeof autoInference.detectionsFound === "number"
                              ? autoInference.detectionsFound.toLocaleString()
                              : "--"}
                          </p>
                        </div>
                      </div>
                      {autoInferenceJobIds.length > 0 && (
                        <p className="mt-3 text-xs">
                          Job {autoInferenceJobIds.join(", ")}. Candidates are not approved until
                          review accepts them.
                        </p>
                      )}
                    </div>
                  )}

                  {!autoInference && (
                    <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
                      Upload-only mode completed. No detection model was run for this upload.
                    </div>
                  )}

                  {uploadResponse.roboflowDetection?.started && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                      Background AI detection has been queued for{" "}
                      {uploadResponse.roboflowDetection.totalImages?.toLocaleString() || 0}{" "}
                      images.
                      {uploadResponse.roboflowDetection.skippedImages
                        ? ` ${uploadResponse.roboflowDetection.skippedImages.toLocaleString()} images were skipped because they are missing GPS coordinates or image dimensions.`
                        : ""}
                      {uploadResponse.roboflowDetection.jobId
                        ? ` Job ID: ${uploadResponse.roboflowDetection.jobId}.`
                        : ""}
                    </div>
                  )}

                  {uploadResponse.roboflowDetection &&
                    !uploadResponse.roboflowDetection.started &&
                    uploadResponse.roboflowDetection.error && (
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
                        Uploads completed, but background AI detection did not start:{" "}
                        {uploadResponse.roboflowDetection.error}
                      </div>
                    )}

                  <section className="rounded-lg border border-slate-200 bg-white p-6">
                    <div className="mb-4 flex flex-col gap-1">
                      <h3 className="text-lg font-semibold text-gray-900">
                        Next step
                      </h3>
                      <p className="text-sm text-gray-500">
                        One primary action is shown first. Other tools are still available below.
                      </p>
                    </div>

                    <div className="space-y-4">
                      {autoInferenceJobIds.length > 0 && autoInference?.status === "completed" ? (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-auto w-full justify-start gap-4 border-2 border-amber-300 bg-amber-50 p-5 hover:border-amber-500 hover:bg-amber-100"
                          onClick={handleStartReview}
                          disabled={reviewStarting}
                        >
                          {reviewStarting ? (
                            <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
                          ) : (
                            <Eye className="h-5 w-5 text-amber-600" />
                          )}
                          <div className="text-left">
                            <div className="text-base font-semibold text-amber-800">
                              Review candidate detections
                            </div>
                            <div className="text-sm text-amber-700">
                              Accept, reject, or correct before counts and exports.
                            </div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-amber-400" />
                        </Button>
                      ) : null}

                      {autoInferenceJobIds.length > 0 && autoInference?.status === "queued" ? (
                        <Link href="/training#inference">
                          <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-4 border-2 border-blue-300 bg-blue-50 p-5 hover:border-blue-500 hover:bg-blue-100"
                          >
                            <Clock className="h-5 w-5 text-blue-600" />
                            <div className="text-left">
                              <div className="text-base font-semibold text-blue-800">
                                Track model run
                              </div>
                              <div className="text-sm text-blue-700">
                                Review candidates when inference completes.
                              </div>
                            </div>
                            <ArrowRight className="ml-auto h-4 w-4 text-blue-400" />
                          </Button>
                        </Link>
                      ) : null}

                      {(!autoInference || !autoInference.started) && (
                        <Link href={imagesHref}>
                          <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-4 border-2 border-blue-300 bg-blue-50 p-5 hover:border-blue-500 hover:bg-blue-100"
                          >
                            <Images className="h-5 w-5 text-blue-600" />
                            <div className="text-left">
                              <div className="text-base font-semibold text-blue-800">
                                View uploaded images
                              </div>
                              <div className="text-sm text-blue-700">
                                Browse this project&apos;s new upload batch.
                              </div>
                            </div>
                            <ArrowRight className="ml-auto h-4 w-4 text-blue-400" />
                          </Button>
                        </Link>
                      )}

                      <div className="grid gap-3 sm:grid-cols-3">
                        <Link href={annotateHref}>
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 bg-white p-4 hover:bg-slate-50"
                        >
                          <Tags className="h-5 w-5 text-purple-600" />
                          <div className="text-left">
                            <div className="font-semibold text-purple-700">Label with SAM3</div>
                            <div className="text-xs text-gray-500">AI-assisted annotation</div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-purple-400" />
                        </Button>
                      </Link>
                      <Link href={imagesHref}>
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 bg-white p-4 hover:bg-slate-50"
                        >
                          <Images className="h-5 w-5 text-blue-600" />
                          <div className="text-left">
                            <div className="font-semibold text-blue-700">View Images</div>
                            <div className="text-xs text-gray-500">Browse uploaded files</div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-blue-400" />
                        </Button>
                      </Link>
                      <Link href={selectedProject ? `/map?project=${selectedProject}` : "/map"}>
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 bg-white p-4 hover:bg-slate-50"
                        >
                          <Map className="h-5 w-5 text-green-600" />
                          <div className="text-left">
                            <div className="font-semibold text-green-700">View on Map</div>
                            <div className="text-xs text-gray-500">See GPS locations</div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-green-400" />
                        </Button>
                      </Link>
                      </div>
                    </div>
                  </section>

                  {/* Upload Results Details */}
                  <details className="rounded-lg border border-gray-200 bg-white">
                    <summary className="cursor-pointer p-4 font-semibold hover:bg-gray-50">
                      Upload Details ({uploadResponse.files.length} files)
                    </summary>
                    <div className="space-y-3 border-t p-4">
                      {uploadResponse.files.map((file) => (
                        <div
                          key={`${file.name}-${file.url}`}
                          className="rounded-lg border border-gray-100 bg-gray-50 p-3"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <p className="text-sm font-medium">{file.name}</p>
                              <p className="text-xs text-gray-500">{file.url}</p>
                            </div>
                            <div className="text-xs text-gray-500">
                              {file.size?.toLocaleString()} bytes
                            </div>
                          </div>
                          {file.warning && (
                            <p className="mt-2 text-xs text-yellow-700">
                              {file.warning}
                            </p>
                          )}
                          {file.error && (
                            <p className="mt-2 text-xs text-red-700">
                              {file.error}
                            </p>
                          )}
                          {file.detections && file.detections.length > 0 && (
                            <p className="mt-2 text-xs text-green-700">
                              {file.detections.length} detections saved for this
                              asset.
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </details>
                </>
              )}

              <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                <h4 className="mb-2 font-semibold">What stays safe</h4>
                <ul className="space-y-1">
                  <li>• Ensure your drone captures GPS metadata in each image.</li>
                  <li>• Keep uploads under 500MB per file for best performance.</li>
                  <li>
                    • Active-model detections are review-gated and remain unapproved until accepted.
                  </li>
                  <li>
                    • V1 displays YOLO boxes and georeferenced centres; segmentation polygons come later.
                  </li>
                </ul>
              </section>
            </CardContent>
          </Card>
      </div>
    </div>
  );
}

export default function UploadPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex items-center justify-center">Loading...</div>}>
      <UploadPageContent />
    </Suspense>
  );
}
