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
  const autoInferenceJobIds = getAutoInferenceJobIds(uploadResponse);
  const autoInference = uploadResponse?.autoInference;
  const successfulUploadCount =
    uploadResponse?.files.filter((file) => file.success !== false).length || 0;

  return (
    <div className="p-6 lg:p-8">
      <div className="mx-auto max-w-5xl space-y-6">
          <Card>
            <CardHeader className="space-y-4">
              <div>
                <CardTitle className="text-2xl">Upload, Run Model, Review</CardTitle>
                <CardDescription>
                  Upload imagery safely first, then optionally run the project&apos;s active
                  detection model and send candidates to review.
                </CardDescription>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  { label: "Upload", icon: Upload },
                  { label: "Run model", icon: Brain },
                  { label: "Review", icon: Eye },
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
              <section className="grid gap-6 md:grid-cols-2">
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="project">Select Project</Label>
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
                            {project.location ? ` – ${project.location}` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {projects.length === 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
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

                  <div className="space-y-2">
                    <Label htmlFor="flightSession">
                      Flight Session (optional)
                    </Label>
                    <Input
                      id="flightSession"
                      placeholder="e.g. Morning Survey A"
                      value={flightSession}
                      onChange={(event) => setFlightSession(event.target.value)}
                    />
                    <p className="text-xs text-gray-500">
                      Used in the S3 key path to keep uploads organised.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="cameraProfile">Camera Profile (optional)</Label>
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
                            {profile.fov ? ` – ${profile.fov}°` : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-gray-500">
                      Applies calibrated focal length + optical center from DJI metadata.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="cameraFov">
                      Camera FOV Override (optional)
                    </Label>
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
                      Overrides DJI metadata when present. Helps fix FOV mismatch issues.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-slate-900">Active detection model</p>
                        <p className="mt-1 text-sm text-slate-600">{activeModelName}</p>
                        <p className="mt-1 text-xs text-slate-500">
                          Backend: {selectedProjectData?.inferenceBackend || "AUTO"}
                        </p>
                      </div>
                      {activeModelLoading ? (
                        <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
                      ) : (
                        <ShieldCheck
                          className={`h-5 w-5 ${activeModelReady ? "text-emerald-600" : "text-slate-300"}`}
                        />
                      )}
                    </div>
                    {!activeModelReady && selectedProjectData?.activeModelId ? (
                      <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        The active model is not ready for inference yet.
                      </p>
                    ) : null}
                    {!selectedProjectData?.activeModelId ? (
                      <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                        Set an active YOLO model in Training before running inference after upload.
                      </p>
                    ) : null}
                  </div>

                  <div className="rounded-lg border border-slate-200 bg-white p-4">
                    <Label className="text-sm font-semibold text-slate-900">Upload action</Label>
                    <div className="mt-3 grid gap-2">
                      <Button
                        type="button"
                        variant={uploadMode === "upload-only" ? "default" : "outline"}
                        className="justify-start"
                        onClick={() => setUploadMode("upload-only")}
                      >
                        <Upload className="mr-2 h-4 w-4" />
                        Upload only
                      </Button>
                      <Button
                        type="button"
                        variant={uploadMode === "run-active" ? "default" : "outline"}
                        className="justify-start"
                        onClick={() => {
                          setRunDetection(false);
                          setUploadMode("run-active");
                        }}
                        disabled={!selectedProjectData?.activeModelId}
                      >
                        <Brain className="mr-2 h-4 w-4" />
                        Run active model after upload
                      </Button>
                    </div>
                    <p className="mt-3 text-xs text-slate-500">
                      Upload always completes first. Model runs are retryable and detections stay
                      pending until review accepts them.
                    </p>
                  </div>

                  <details className="rounded-lg border border-slate-200 bg-white">
                    <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-semibold text-slate-900 hover:bg-slate-50">
                      <Settings className="h-4 w-4 text-slate-500" />
                      Advanced model fallback
                    </summary>
                    <div className="space-y-4 border-t border-slate-200 p-4">
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
                </div>
              </section>

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
                      Direct-to-S3 Uploads
                    </h3>
                    <p className="text-sm text-gray-500">
                      Files are sent straight to S3 using multipart uploads, then
                      finalized server-side.
                    </p>
                    <p className="text-xs text-gray-400">
                      Step 1 uploads to S3; Step 2 reads EXIF; Step 3 runs the active model only
                      when selected.
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
                  Processing uploaded files... upload finalization runs first; model inference starts
                  only after the uploaded assets are saved.
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

                  {/* Next Steps */}
                  <section className="rounded-lg border-2 border-green-300 bg-gradient-to-r from-green-50 to-blue-50 p-6">
                    <h3 className="mb-4 text-lg font-semibold text-gray-800">
                      What would you like to do next?
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      {autoInferenceJobIds.length > 0 && autoInference?.status === "completed" && (
                        <Button
                          type="button"
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 border-2 border-amber-200 bg-white p-4 hover:border-amber-400 hover:bg-amber-50"
                          onClick={handleStartReview}
                          disabled={reviewStarting}
                        >
                          {reviewStarting ? (
                            <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
                          ) : (
                            <Eye className="h-5 w-5 text-amber-600" />
                          )}
                          <div className="text-left">
                            <div className="font-semibold text-amber-700">Review candidates</div>
                            <div className="text-xs text-gray-500">Accept, reject, or correct</div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-amber-400" />
                        </Button>
                      )}
                      {autoInferenceJobIds.length > 0 && autoInference?.status === "queued" && (
                        <Link href="/training#inference">
                          <Button
                            variant="outline"
                            className="h-auto w-full justify-start gap-3 border-2 border-amber-200 bg-white p-4 hover:border-amber-400 hover:bg-amber-50"
                          >
                            <Clock className="h-5 w-5 text-amber-600" />
                            <div className="text-left">
                              <div className="font-semibold text-amber-700">Track model run</div>
                              <div className="text-xs text-gray-500">Review when complete</div>
                            </div>
                            <ArrowRight className="ml-auto h-4 w-4 text-amber-400" />
                          </Button>
                        </Link>
                      )}
                      <Link href={
                        uploadResponse.files.find(f => f.success !== false && f.id)?.id
                          ? `/annotate/${uploadResponse.files.find(f => f.success !== false && f.id)?.id}`
                          : `/images${selectedProject ? `?project=${selectedProject}` : ''}`
                      }>
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 border-2 border-purple-200 bg-white p-4 hover:border-purple-400 hover:bg-purple-50"
                        >
                          <Tags className="h-5 w-5 text-purple-600" />
                          <div className="text-left">
                            <div className="font-semibold text-purple-700">Label with SAM3</div>
                            <div className="text-xs text-gray-500">AI-assisted annotation</div>
                          </div>
                          <ArrowRight className="ml-auto h-4 w-4 text-purple-400" />
                        </Button>
                      </Link>
                      <Link href="/images">
                        <Button
                          variant="outline"
                          className="h-auto w-full justify-start gap-3 border-2 border-blue-200 bg-white p-4 hover:border-blue-400 hover:bg-blue-50"
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
                          className="h-auto w-full justify-start gap-3 border-2 border-green-200 bg-white p-4 hover:border-green-400 hover:bg-green-50"
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
                <h4 className="mb-2 font-semibold">Safe Upload Notes</h4>
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
