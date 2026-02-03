"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { WorkflowGuide } from "@/components/workflow-guide";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  Download,
  RefreshCw,
  Rocket,
  Settings,
  ShieldCheck,
  XCircle,
  PlayCircle,
} from "lucide-react";

interface Project {
  id: string;
  name: string;
  location: string | null;
  activeModelId?: string | null;
  autoInferenceEnabled?: boolean;
  _count?: { assets: number };
}

interface TrainingDataset {
  id: string;
  name: string;
  description?: string | null;
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classes: string[];
  createdAt: string;
  project?: { id: string; name: string } | null;
}

interface TrainingJob {
  id: string;
  status: string;
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
  finalMAP50?: number | null;
  finalPrecision?: number | null;
  finalRecall?: number | null;
}

interface TrainedModel {
  id: string;
  name: string;
  version: number;
  displayName?: string | null;
  classes?: string[];
  mAP50?: number | null;
  status: string;
  isActive: boolean;
  createdAt: string;
}

interface InferenceJob {
  id: string;
  status: string;
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
}

interface DatasetPreview {
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classes: string[];
  classCounts: Record<string, number>;
  availableClasses: Array<{ name: string; count: number }>;
}

interface HealthResponse {
  status: "healthy" | "unhealthy";
  gpu_available: boolean;
  gpu_name?: string;
  active_training_jobs: number;
  cached_models: string[];
}

const ACTIVE_STATUSES = new Set(["QUEUED", "PREPARING", "RUNNING", "UPLOADING"]);
const STATUS_STYLES: Record<string, string> = {
  QUEUED: "bg-slate-100 text-slate-700",
  PREPARING: "bg-blue-100 text-blue-700",
  RUNNING: "bg-green-100 text-green-700",
  UPLOADING: "bg-amber-100 text-amber-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const INFERENCE_STATUS_STYLES: Record<string, string> = {
  PENDING: "bg-slate-100 text-slate-700",
  PROCESSING: "bg-blue-100 text-blue-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  FAILED: "bg-red-100 text-red-700",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const formatStatus = (status: string) =>
  status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const formatMetric = (value?: number | null) =>
  typeof value === "number" ? value.toFixed(2) : "--";

const formatDate = (value?: string | null) => {
  if (!value) return "--";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "--" : parsed.toLocaleDateString();
};

const formatMinutes = (minutes: number) => {
  if (!Number.isFinite(minutes)) return "--";
  if (minutes < 60) return `~${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return `~${hours}h${remaining ? ` ${remaining}m` : ""}`;
};

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

export default function TrainingPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [datasets, setDatasets] = useState<TrainingDataset[]>([]);
  const [jobs, setJobs] = useState<TrainingJob[]>([]);
  const [models, setModels] = useState<TrainedModel[]>([]);
  const [inferenceJobs, setInferenceJobs] = useState<InferenceJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [health, setHealth] = useState<{
    loading: boolean;
    available: boolean;
    error?: string;
    details?: HealthResponse;
  }>({
    loading: true,
    available: true,
  });

  const [createDatasetOpen, setCreateDatasetOpen] = useState(false);
  const [startTrainingOpen, setStartTrainingOpen] = useState(false);
  const [runInferenceOpen, setRunInferenceOpen] = useState(false);
  const [selectedInferenceModel, setSelectedInferenceModel] = useState<TrainedModel | null>(null);

  const [datasetForm, setDatasetForm] = useState({
    name: "",
    description: "",
    projectId: "",
    classes: [] as string[],
    splitTrain: 70,
    splitVal: 20,
    splitTest: 10,
    includeAIDetections: true,
    includeManualAnnotations: true,
    minConfidence: 0.5,
  });

  const [availableClasses, setAvailableClasses] = useState<
    Array<{ name: string; count: number }>
  >([]);
  const [preview, setPreview] = useState<DatasetPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [creatingDataset, setCreatingDataset] = useState(false);

  const [trainingForm, setTrainingForm] = useState({
    datasetId: "",
    baseModel: "yolo11m",
    epochs: 100,
    batchSize: 16,
    imageSize: 640,
  });
  const [inferenceForm, setInferenceForm] = useState({
    projectId: "",
    confidence: 0.25,
  });
  const [settingsProjectId, setSettingsProjectId] = useState("");
  const [savingAutoInference, setSavingAutoInference] = useState(false);
  const [inferencePreview, setInferencePreview] = useState<{
    totalImages: number;
    skippedImages: number;
    duplicateImages: number;
    skippedReason?: string;
  } | null>(null);
  const [inferencePreviewLoading, setInferencePreviewLoading] = useState(false);
  const [startingInference, setStartingInference] = useState(false);
  const [startingTraining, setStartingTraining] = useState(false);
  const [cancelJobId, setCancelJobId] = useState<string | null>(null);
  const [cancelInferenceJobId, setCancelInferenceJobId] = useState<string | null>(null);
  const [activatingModelId, setActivatingModelId] = useState<string | null>(null);
  const [downloadingModelId, setDownloadingModelId] = useState<string | null>(null);
  const pollingInFlight = useRef(false);
  const inferencePollingInFlight = useRef(false);

  const activeJobs = useMemo(
    () => jobs.filter((job) => ACTIVE_STATUSES.has(job.status)),
    [jobs]
  );

  // Stable reference for polling - only changes when active job IDs change
  const activeJobIds = useMemo(
    () => activeJobs.map((job) => job.id).join(","),
    [activeJobs]
  );

  const activeInferenceJobs = useMemo(
    () => inferenceJobs.filter((job) => ["PENDING", "PROCESSING"].includes(job.status)),
    [inferenceJobs]
  );
  const recentInferenceJobs = useMemo(
    () =>
      inferenceJobs
        .filter((job) => !["PENDING", "PROCESSING"].includes(job.status))
        .slice(0, 4),
    [inferenceJobs]
  );
  const selectedSettingsProject = useMemo(
    () => projects.find((project) => project.id === settingsProjectId) || null,
    [projects, settingsProjectId]
  );
  const activeModelForProject = useMemo(() => {
    if (!selectedSettingsProject?.activeModelId) return null;
    return (
      models.find((model) => model.id === selectedSettingsProject.activeModelId) ||
      null
    );
  }, [models, selectedSettingsProject]);

  const activeInferenceIds = useMemo(
    () => activeInferenceJobs.map((job) => job.id).join(","),
    [activeInferenceJobs]
  );

  const selectedDataset = useMemo(
    () => datasets.find((dataset) => dataset.id === trainingForm.datasetId),
    [datasets, trainingForm.datasetId]
  );

  const estimatedTrainingTime = useMemo(() => {
    if (!selectedDataset) return null;
    const batchSize = Math.max(1, trainingForm.batchSize);
    const batchesPerEpoch = Math.ceil(selectedDataset.imageCount / batchSize);
    const secondsPerEpoch = batchesPerEpoch * 0.5;
    const totalSeconds = secondsPerEpoch * trainingForm.epochs;
    const minutes = Math.ceil(totalSeconds / 60);
    return {
      minutes,
      label: formatMinutes(minutes),
    };
  }, [selectedDataset, trainingForm.batchSize, trainingForm.epochs]);

  const loadProjects = useCallback(async () => {
    const response = await fetch("/api/projects?pageSize=200");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load projects");
    }
    setProjects(data.projects || []);
  }, []);

  const loadDatasets = useCallback(async () => {
    const response = await fetch("/api/training/datasets?limit=50");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load datasets");
    }
    setDatasets(data.datasets || []);
  }, []);

  const loadJobs = useCallback(async () => {
    const response = await fetch("/api/training/jobs?limit=50");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load training jobs");
    }
    setJobs(data.jobs || []);
  }, []);

  const loadModels = useCallback(async () => {
    const params = new URLSearchParams({ limit: "50" });
    if (settingsProjectId) {
      params.set("projectId", settingsProjectId);
    }
    const response = await fetch(`/api/training/models?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load models");
    }
    setModels(data.models || []);
  }, [settingsProjectId]);

  const loadInferenceJobs = useCallback(async () => {
    const response = await fetch("/api/inference/jobs?limit=30");
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load inference jobs");
    }
    setInferenceJobs(data.jobs || []);
  }, []);

  const loadHealth = useCallback(async () => {
    setHealth((prev) => ({ ...prev, loading: true }));
    try {
      const response = await fetch("/api/training/health");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to check service health");
      }
      setHealth({
        loading: false,
        available: Boolean(data.available),
        error: data.error,
        details: data.health,
      });
    } catch (err) {
      setHealth({
        loading: false,
        available: false,
        error: err instanceof Error ? err.message : "Service unavailable",
      });
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setError(null);
    setNotice(null);
    try {
      await Promise.all([
        loadProjects(),
        loadDatasets(),
        loadJobs(),
        loadModels(),
        loadInferenceJobs(),
        loadHealth(),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load training data");
    }
  }, [loadProjects, loadDatasets, loadJobs, loadModels, loadInferenceJobs, loadHealth]);

  useEffect(() => {
    setLoading(true);
    refreshAll().finally(() => setLoading(false));
  }, [refreshAll]);

  useEffect(() => {
    if (projects.length > 0 && !datasetForm.projectId) {
      setDatasetForm((prev) => ({ ...prev, projectId: projects[0].id }));
    }
  }, [projects, datasetForm.projectId]);

  useEffect(() => {
    if (datasets.length > 0 && !trainingForm.datasetId) {
      setTrainingForm((prev) => ({ ...prev, datasetId: datasets[0].id }));
    }
  }, [datasets, trainingForm.datasetId]);

  useEffect(() => {
    if (projects.length > 0 && !inferenceForm.projectId) {
      setInferenceForm((prev) => ({ ...prev, projectId: projects[0].id }));
    }
  }, [projects, inferenceForm.projectId]);

  useEffect(() => {
    if (projects.length > 0 && !settingsProjectId) {
      setSettingsProjectId(projects[0].id);
    }
  }, [projects, settingsProjectId]);

  useEffect(() => {
    if (!settingsProjectId) return;
    loadModels().catch(() => undefined);
  }, [settingsProjectId, loadModels]);

  const loadClassOptions = useCallback(async () => {
    if (!datasetForm.projectId) return;

    setPreviewLoading(true);
    setError(null);
    setPreview(null);
    try {
      const response = await fetch("/api/training/datasets/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: datasetForm.projectId,
          includeAIDetections: datasetForm.includeAIDetections,
          includeManualAnnotations: datasetForm.includeManualAnnotations,
          minConfidence: datasetForm.minConfidence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load class options");
      }
      const classes = data.preview?.availableClasses || [];
      setAvailableClasses(classes);
      const classNames = classes.map((entry: { name: string }) => entry.name);
      setDatasetForm((prev) => {
        const retained = prev.classes.filter((cls) => classNames.includes(cls));
        const nextClasses = retained.length > 0 ? retained : classNames;
        return { ...prev, classes: nextClasses };
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load classes");
      setAvailableClasses([]);
    } finally {
      setPreviewLoading(false);
    }
  }, [
    datasetForm.projectId,
    datasetForm.includeAIDetections,
    datasetForm.includeManualAnnotations,
    datasetForm.minConfidence,
  ]);

  const loadInferencePreview = useCallback(async () => {
    if (!selectedInferenceModel || !inferenceForm.projectId) return;
    setInferencePreviewLoading(true);
    try {
      const response = await fetch("/api/inference/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: selectedInferenceModel.id,
          projectId: inferenceForm.projectId,
          confidence: inferenceForm.confidence,
          saveDetections: true,
          preview: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to preview inference");
      }
      setInferencePreview({
        totalImages: data.totalImages || 0,
        skippedImages: data.skippedImages || 0,
        duplicateImages: data.duplicateImages || 0,
        skippedReason: data.skippedReason,
      });
    } catch {
      setInferencePreview(null);
    } finally {
      setInferencePreviewLoading(false);
    }
  }, [selectedInferenceModel, inferenceForm.projectId, inferenceForm.confidence]);

  useEffect(() => {
    if (!createDatasetOpen) return;
    loadClassOptions();
  }, [
    createDatasetOpen,
    datasetForm.projectId,
    datasetForm.includeAIDetections,
    datasetForm.includeManualAnnotations,
    datasetForm.minConfidence,
    loadClassOptions,
  ]);

  useEffect(() => {
    if (!runInferenceOpen) return;
    loadInferencePreview();
  }, [runInferenceOpen, loadInferencePreview]);

  useEffect(() => {
    if (runInferenceOpen) return;
    setInferencePreview(null);
    setInferencePreviewLoading(false);
  }, [runInferenceOpen]);

  useEffect(() => {
    // Use activeJobIds as stable dependency to prevent infinite interval recreation
    if (!activeJobIds) return;

    // Parse job IDs from the stable string
    const jobIds = activeJobIds.split(",").filter(Boolean);
    if (jobIds.length === 0) return;

    const interval = setInterval(async () => {
      if (pollingInFlight.current) return;
      pollingInFlight.current = true;
      try {
        const updates = await Promise.all(
          jobIds.map(async (jobId) => {
            const response = await fetch(`/api/training/jobs/${jobId}`);
            if (!response.ok) return null;
            return (await response.json()) as TrainingJob;
          })
        );
        setJobs((prev) =>
          prev.map((job) => {
            const update = updates.find((u) => u && u.id === job.id);
            return update || job;
          })
        );
      } catch (err) {
        console.error("Failed to poll training jobs:", err);
      } finally {
        pollingInFlight.current = false;
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activeJobIds]);

  useEffect(() => {
    if (!activeInferenceIds) return;

    const interval = setInterval(async () => {
      if (inferencePollingInFlight.current) return;
      inferencePollingInFlight.current = true;
      try {
        await loadInferenceJobs();
      } catch (err) {
        console.error("Failed to poll inference jobs:", err);
      } finally {
        inferencePollingInFlight.current = false;
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [activeInferenceIds, loadInferenceJobs]);

  const handlePreview = async () => {
    if (!datasetForm.projectId) {
      setError("Select a project to preview.");
      return;
    }
    if (datasetForm.classes.length === 0) {
      setError("Select at least one class to preview.");
      return;
    }
    if (splitTotal !== 100) {
      setError("Train/val/test splits must total 100%.");
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/training/datasets/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: datasetForm.projectId,
          classes: datasetForm.classes,
          splitRatio: {
            train: datasetForm.splitTrain / 100,
            val: datasetForm.splitVal / 100,
            test: datasetForm.splitTest / 100,
          },
          includeAIDetections: datasetForm.includeAIDetections,
          includeManualAnnotations: datasetForm.includeManualAnnotations,
          minConfidence: datasetForm.minConfidence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to preview dataset");
      }
      setPreview(data.preview);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to preview dataset");
      setPreview(null);
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleCreateDataset = async () => {
    if (!datasetForm.projectId || datasetForm.classes.length === 0) {
      setError("Project and classes are required.");
      return;
    }
    if (splitTotal !== 100) {
      setError("Train/val/test splits must total 100%.");
      return;
    }

    setCreatingDataset(true);
    setError(null);
    try {
      const response = await fetch("/api/training/datasets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: datasetForm.name,
          description: datasetForm.description || undefined,
          projectId: datasetForm.projectId,
          classes: datasetForm.classes,
          splitRatio: {
            train: datasetForm.splitTrain / 100,
            val: datasetForm.splitVal / 100,
            test: datasetForm.splitTest / 100,
          },
          includeAIDetections: datasetForm.includeAIDetections,
          includeManualAnnotations: datasetForm.includeManualAnnotations,
          minConfidence: datasetForm.minConfidence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create dataset");
      }

      setNotice("Dataset created and uploaded to S3.");
      setCreateDatasetOpen(false);
      setDatasetForm((prev) => ({
        ...prev,
        name: "",
        description: "",
      }));
      await loadDatasets();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create dataset");
    } finally {
      setCreatingDataset(false);
    }
  };

  const handleStartTraining = async () => {
    if (!trainingForm.datasetId) {
      setError("Select a dataset before starting training.");
      return;
    }

    setStartingTraining(true);
    setError(null);
    try {
      const response = await fetch("/api/training/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          datasetId: trainingForm.datasetId,
          baseModel: trainingForm.baseModel,
          epochs: trainingForm.epochs,
          batchSize: trainingForm.batchSize,
          imageSize: trainingForm.imageSize,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to start training");
      }
      setNotice("Training job queued. Monitoring progress.");
      setStartTrainingOpen(false);
      await loadJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start training");
    } finally {
      setStartingTraining(false);
    }
  };

  const handleStartInference = async () => {
    if (!selectedInferenceModel || !inferenceForm.projectId) {
      setError("Select a model and project before running inference.");
      return;
    }

    setStartingInference(true);
    setError(null);
    try {
      const response = await fetch("/api/inference/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          modelId: selectedInferenceModel.id,
          projectId: inferenceForm.projectId,
          confidence: inferenceForm.confidence,
          saveDetections: true,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to start inference");
      }
      setNotice("Inference job started. Results will appear in review.");
      setRunInferenceOpen(false);
      await loadInferenceJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start inference");
    } finally {
      setStartingInference(false);
    }
  };

  const handleCancelInferenceJob = async (jobId: string) => {
    if (!confirm("Cancel this inference job?")) return;
    setCancelInferenceJobId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/inference/${jobId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to cancel inference job");
      }
      await loadInferenceJobs();
      setNotice("Inference job cancelled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel inference job");
    } finally {
      setCancelInferenceJobId(null);
    }
  };

  const handleCancelJob = async (jobId: string) => {
    if (!confirm("Cancel this training job?")) return;
    setCancelJobId(jobId);
    setError(null);
    try {
      const response = await fetch(`/api/training/jobs/${jobId}`, { method: "DELETE" });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to cancel training job");
      }
      await loadJobs();
      setNotice("Training job cancelled.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to cancel training job");
    } finally {
      setCancelJobId(null);
    }
  };

  const handleActivateModel = async (modelId: string) => {
    if (!settingsProjectId) {
      setError("Select a project to activate this model.");
      return;
    }
    setActivatingModelId(modelId);
    setError(null);
    try {
      const response = await fetch(`/api/training/models/${modelId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: settingsProjectId }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data?.details ? `${data.error}: ${data.details}` : data?.error;
        throw new Error(message || "Failed to activate model");
      }
      await loadModels();
      setProjects((prev) =>
        prev.map((project) =>
          project.id === settingsProjectId
            ? { ...project, activeModelId: modelId }
            : project
        )
      );
      setNotice("Model activated for detection.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate model");
    } finally {
      setActivatingModelId(null);
    }
  };

  const handleAutoInferenceToggle = async (enabled: boolean) => {
    if (!settingsProjectId) {
      setError("Select a project to update inference settings.");
      return;
    }
    setSavingAutoInference(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/projects/${settingsProjectId}/settings`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ autoInferenceEnabled: enabled }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update settings");
      }
      setProjects((prev) =>
        prev.map((project) =>
          project.id === settingsProjectId
            ? {
                ...project,
                autoInferenceEnabled: data.project?.autoInferenceEnabled,
                activeModelId: data.project?.activeModelId ?? project.activeModelId,
              }
            : project
        )
      );
      setNotice(
        enabled
          ? "Auto inference enabled for this project."
          : "Auto inference disabled for this project."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update settings");
    } finally {
      setSavingAutoInference(false);
    }
  };

  const handleDownloadModel = async (modelId: string) => {
    setDownloadingModelId(modelId);
    setError(null);
    try {
      const response = await fetch(`/api/training/models/${modelId}/download`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to download weights");
      }
      if (data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to download weights");
    } finally {
      setDownloadingModelId(null);
    }
  };

  const handleReviewInference = async (job: InferenceJob) => {
    try {
      const response = await fetch("/api/review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: job.project.id,
          workflowType: "yolo_inference",
          targetType: "both",
          inferenceJobIds: [job.id],
          confidenceThreshold:
            typeof job.config.confidence === "number" ? job.config.confidence : 0.7,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || "Failed to create review session");
      }

      const sessionId = data.session?.id;
      if (!sessionId) {
        throw new Error("Review session missing from response");
      }

      router.push(`/review?sessionId=${sessionId}`);
    } catch (err) {
      console.error("Failed to start unified review:", err);
      setError(err instanceof Error ? err.message : "Failed to start review");
    }
  };

  const getInferenceModelLabel = useCallback(
    (job: InferenceJob) => {
      if (job.config?.modelName) return job.config.modelName;
      if (job.config?.modelId) {
        const model = models.find((item) => item.id === job.config.modelId);
        if (model) {
          return model.displayName || `${model.name} v${model.version}`;
        }
      }
      return "Custom model";
    },
    [models]
  );

  const splitTotal = datasetForm.splitTrain + datasetForm.splitVal + datasetForm.splitTest;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-3">
            <Link href="/training-hub">
              <Button variant="ghost" size="sm" className="gap-2 -ml-2">
                <ArrowLeft className="h-4 w-4" />
                Training Hub
              </Button>
            </Link>
            <div className="h-10 w-10 rounded-lg bg-gradient-to-br from-green-500 to-blue-500 flex items-center justify-center text-white">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-xl font-semibold text-gray-900">YOLO Training Dashboard</h1>
                {health.loading ? (
                  <Badge variant="secondary">Checking...</Badge>
                ) : health.available ? (
                  <Badge className="bg-emerald-100 text-emerald-700">Service Online</Badge>
                ) : (
                  <Badge className="bg-red-100 text-red-700">Service Offline</Badge>
                )}
              </div>
              <p className="text-sm text-gray-600">
                Build datasets, run training jobs, and activate models for detection.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={refreshAll} disabled={loading}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </Button>
            <Dialog open={createDatasetOpen} onOpenChange={setCreateDatasetOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-green-500 to-blue-500 text-white">
                  Create Dataset
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Create Training Dataset</DialogTitle>
                  <DialogDescription>
                    Prepare a YOLO dataset from verified annotations.
                  </DialogDescription>
                </DialogHeader>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="dataset-name">Dataset name</Label>
                    <Input
                      id="dataset-name"
                      placeholder="Northern paddock - Jan"
                      value={datasetForm.name}
                      onChange={(event) =>
                        setDatasetForm((prev) => ({ ...prev, name: event.target.value }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="dataset-project">Source project</Label>
                    <Select
                      value={datasetForm.projectId}
                      onValueChange={(value) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          projectId: value,
                          classes: [],
                        }))
                      }
                    >
                      <SelectTrigger id="dataset-project">
                        <SelectValue placeholder="Select a project" />
                      </SelectTrigger>
                      <SelectContent>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="dataset-description">Description (optional)</Label>
                  <Input
                    id="dataset-description"
                    placeholder="High-density lantana flight"
                    value={datasetForm.description}
                    onChange={(event) =>
                      setDatasetForm((prev) => ({ ...prev, description: event.target.value }))
                    }
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <Label>Classes to include</Label>
                    {previewLoading && (
                      <span className="text-xs text-gray-500">Refreshing...</span>
                    )}
                  </div>
                  <div className="grid gap-2 md:grid-cols-2">
                    {availableClasses.length === 0 && (
                      <p className="text-sm text-gray-500">
                        No classes found for this project yet.
                      </p>
                    )}
                    {availableClasses.map((entry) => {
                      const checked = datasetForm.classes.includes(entry.name);
                      return (
                        <label
                          key={entry.name}
                          className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(value) => {
                              setDatasetForm((prev) => {
                                const selected = new Set(prev.classes);
                                if (value) {
                                  selected.add(entry.name);
                                } else {
                                  selected.delete(entry.name);
                                }
                                return { ...prev, classes: Array.from(selected) };
                              });
                            }}
                          />
                          <span className="flex-1">{entry.name}</span>
                          <Badge variant="secondary">{entry.count}</Badge>
                        </label>
                      );
                    })}
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="space-y-2">
                    <Label htmlFor="split-train">Train split (%)</Label>
                    <Input
                      id="split-train"
                      type="number"
                      min={0}
                      max={100}
                      value={datasetForm.splitTrain}
                      onChange={(event) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          splitTrain: clampNumber(Number(event.target.value), 0, 100),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="split-val">Val split (%)</Label>
                    <Input
                      id="split-val"
                      type="number"
                      min={0}
                      max={100}
                      value={datasetForm.splitVal}
                      onChange={(event) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          splitVal: clampNumber(Number(event.target.value), 0, 100),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="split-test">Test split (%)</Label>
                    <Input
                      id="split-test"
                      type="number"
                      min={0}
                      max={100}
                      value={datasetForm.splitTest}
                      onChange={(event) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          splitTest: clampNumber(Number(event.target.value), 0, 100),
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-3">
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={datasetForm.includeAIDetections}
                      onCheckedChange={(value) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          includeAIDetections: Boolean(value),
                        }))
                      }
                    />
                    <span className="text-sm">Include AI detections</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={datasetForm.includeManualAnnotations}
                      onCheckedChange={(value) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          includeManualAnnotations: Boolean(value),
                        }))
                      }
                    />
                    <span className="text-sm">Include manual labels</span>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="min-confidence">Min confidence</Label>
                    <Input
                      id="min-confidence"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={datasetForm.minConfidence}
                      onChange={(event) =>
                        setDatasetForm((prev) => ({
                          ...prev,
                          minConfidence: clampNumber(Number(event.target.value), 0, 1),
                        }))
                      }
                    />
                  </div>
                </div>

                <Card className="border-dashed border-gray-200">
                  <CardHeader>
                    <CardTitle className="text-base">Preview counts</CardTitle>
                    <CardDescription>
                      {splitTotal !== 100
                        ? `Split totals ${splitTotal}% (must equal 100%).`
                        : "Counts reflect your current class selection."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {preview ? (
                      <>
                        <div className="grid gap-3 md:grid-cols-4 text-sm">
                          <div className="rounded-md bg-white p-3 border border-gray-100">
                            <p className="text-xs text-gray-500">Images</p>
                            <p className="text-lg font-semibold">{preview.imageCount}</p>
                          </div>
                          <div className="rounded-md bg-white p-3 border border-gray-100">
                            <p className="text-xs text-gray-500">Labels</p>
                            <p className="text-lg font-semibold">{preview.labelCount}</p>
                          </div>
                          <div className="rounded-md bg-white p-3 border border-gray-100">
                            <p className="text-xs text-gray-500">Train / Val / Test</p>
                            <p className="text-lg font-semibold">
                              {preview.trainCount} / {preview.valCount} / {preview.testCount}
                            </p>
                          </div>
                          <div className="rounded-md bg-white p-3 border border-gray-100">
                            <p className="text-xs text-gray-500">Classes</p>
                            <p className="text-lg font-semibold">{preview.classes.length}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {Object.entries(preview.classCounts).map(([name, count]) => (
                            <Badge key={name} variant="secondary">
                              {name}: {count}
                            </Badge>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="text-sm text-gray-500">
                        Click preview to estimate images and labels.
                      </p>
                    )}
                    <Button
                      variant="outline"
                      onClick={handlePreview}
                      disabled={previewLoading || datasetForm.classes.length === 0 || splitTotal !== 100}
                    >
                      {previewLoading ? "Previewing..." : "Preview counts"}
                    </Button>
                  </CardContent>
                </Card>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setCreateDatasetOpen(false)}
                    disabled={creatingDataset}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleCreateDataset}
                    disabled={
                      creatingDataset ||
                      !datasetForm.name ||
                      !datasetForm.projectId ||
                      datasetForm.classes.length === 0 ||
                      splitTotal !== 100
                    }
                  >
                    {creatingDataset ? "Creating..." : "Create Dataset"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={startTrainingOpen} onOpenChange={setStartTrainingOpen}>
              <DialogTrigger asChild>
                <Button variant="outline" disabled={!health.available}>
                  Start Training
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Start Training</DialogTitle>
                  <DialogDescription>
                    Configure your YOLO training job.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <Label htmlFor="training-dataset">Dataset</Label>
                  <Select
                    value={trainingForm.datasetId}
                    onValueChange={(value) =>
                      setTrainingForm((prev) => ({ ...prev, datasetId: value }))
                    }
                  >
                    <SelectTrigger id="training-dataset">
                      <SelectValue placeholder="Select dataset" />
                    </SelectTrigger>
                    <SelectContent>
                      {datasets.map((dataset) => (
                        <SelectItem key={dataset.id} value={dataset.id}>
                          {dataset.name} ({dataset.imageCount} images)
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="base-model">Base model</Label>
                    <Select
                      value={trainingForm.baseModel}
                      onValueChange={(value) =>
                        setTrainingForm((prev) => ({ ...prev, baseModel: value }))
                      }
                    >
                      <SelectTrigger id="base-model">
                        <SelectValue placeholder="Select model" />
                      </SelectTrigger>
                      <SelectContent>
                        {["yolo11n", "yolo11s", "yolo11m", "yolo11l", "yolo11x"].map((model) => (
                          <SelectItem key={model} value={model}>
                            {model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="epochs">Epochs</Label>
                    <Input
                      id="epochs"
                      type="number"
                      min={1}
                      max={500}
                      value={trainingForm.epochs}
                      onChange={(event) =>
                        setTrainingForm((prev) => ({
                          ...prev,
                          epochs: clampNumber(Number(event.target.value), 1, 500),
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="batch-size">Batch size</Label>
                    <Input
                      id="batch-size"
                      type="number"
                      min={1}
                      max={128}
                      value={trainingForm.batchSize}
                      onChange={(event) =>
                        setTrainingForm((prev) => ({
                          ...prev,
                          batchSize: clampNumber(Number(event.target.value), 1, 128),
                        }))
                      }
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="image-size">Image size</Label>
                    <Input
                      id="image-size"
                      type="number"
                      min={320}
                      max={1280}
                      step={32}
                      value={trainingForm.imageSize}
                      onChange={(event) =>
                        setTrainingForm((prev) => ({
                          ...prev,
                          imageSize: clampNumber(Number(event.target.value), 320, 1280),
                        }))
                      }
                    />
                  </div>
                </div>

                <div className="rounded-md border border-gray-200 bg-gray-50 px-4 py-3 text-sm text-gray-700">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="h-4 w-4 text-emerald-600" />
                    <span>
                      Estimated training time:{" "}
                      {estimatedTrainingTime ? estimatedTrainingTime.label : "--"}
                    </span>
                  </div>
                </div>

                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setStartTrainingOpen(false)}
                    disabled={startingTraining}
                  >
                    Cancel
                  </Button>
                  <Button
                    onClick={handleStartTraining}
                    disabled={startingTraining || !trainingForm.datasetId || !health.available}
                  >
                    {startingTraining ? "Starting..." : "Start Training"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Dialog open={runInferenceOpen} onOpenChange={setRunInferenceOpen}>
              <DialogContent className="max-w-xl">
                <DialogHeader>
                  <DialogTitle>Run Model Inference</DialogTitle>
                  <DialogDescription>
                    Generate draft detections to review in Training Hub.
                  </DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <Label>Model</Label>
                  <Input
                    value={
                      selectedInferenceModel
                        ? selectedInferenceModel.displayName ||
                          `${selectedInferenceModel.name} v${selectedInferenceModel.version}`
                        : "Select a model"
                    }
                    readOnly
                  />
                </div>

                <div className="space-y-3">
                  <Label htmlFor="inference-project">Target project</Label>
                  <Select
                    value={inferenceForm.projectId}
                    onValueChange={(value) =>
                      setInferenceForm((prev) => ({ ...prev, projectId: value }))
                    }
                  >
                    <SelectTrigger id="inference-project">
                      <SelectValue placeholder="Select a project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Confidence threshold</Label>
                  <div className="flex items-center gap-3">
                    <Slider
                      min={0.05}
                      max={0.95}
                      step={0.05}
                      value={[inferenceForm.confidence]}
                      onValueChange={(value) =>
                        setInferenceForm((prev) => ({
                          ...prev,
                          confidence: value[0] ?? prev.confidence,
                        }))
                      }
                    />
                    <Input
                      className="w-24"
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={inferenceForm.confidence}
                      onChange={(event) =>
                        setInferenceForm((prev) => ({
                          ...prev,
                          confidence: clampNumber(Number(event.target.value), 0, 1),
                        }))
                      }
                    />
                  </div>
                </div>

                <Card className="border-dashed border-gray-200">
                  <CardHeader>
                    <CardTitle className="text-base">Preview</CardTitle>
                    <CardDescription>
                      {inferencePreviewLoading
                        ? "Calculating eligible images..."
                        : "Counts exclude images already processed by this model."}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-3 text-sm">
                    <div className="rounded-md bg-white p-3 border border-gray-100">
                      <p className="text-xs text-gray-500">Eligible images</p>
                      <p className="text-lg font-semibold">
                        {inferencePreview ? inferencePreview.totalImages : "--"}
                      </p>
                    </div>
                    <div className="rounded-md bg-white p-3 border border-gray-100">
                      <p className="text-xs text-gray-500">Skipped</p>
                      <p className="text-lg font-semibold">
                        {inferencePreview ? inferencePreview.skippedImages : "--"}
                      </p>
                    </div>
                    <div className="rounded-md bg-white p-3 border border-gray-100">
                      <p className="text-xs text-gray-500">Duplicates</p>
                      <p className="text-lg font-semibold">
                        {inferencePreview ? inferencePreview.duplicateImages : "--"}
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <DialogFooter>
                  <Button variant="outline" onClick={() => setRunInferenceOpen(false)}>
                    Cancel
                  </Button>
                  <Button
                    onClick={handleStartInference}
                    disabled={
                      startingInference ||
                      !selectedInferenceModel ||
                      !inferenceForm.projectId ||
                      (inferencePreview && inferencePreview.totalImages === 0)
                    }
                  >
                    {startingInference ? "Starting..." : "Start Inference"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Link href="/dashboard">
              <Button variant="outline">Back to Dashboard</Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {!health.loading && !health.available && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              <span>
                YOLO service is unavailable. Dataset creation is available, but training and
                model activation are disabled.
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={loadHealth}>
              Retry
            </Button>
          </div>
        )}

        <WorkflowGuide current="training" />

        {notice && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {notice}
          </div>
        )}

        {error && (
          <div className="fixed bottom-6 right-6 z-50 max-w-md rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800 shadow-lg">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 mt-0.5" />
              <span className="flex-1">{error}</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
                className="h-6 px-2 text-red-700 hover:bg-red-100"
              >
                Dismiss
              </Button>
            </div>
          </div>
        )}

        <section id="training" className="grid gap-6 lg:grid-cols-3">
          <Card id="inference">
            <CardHeader>
              <CardTitle>Active Training Jobs</CardTitle>
              <CardDescription>Live progress for current runs.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                <p className="text-sm text-gray-500">Loading jobs...</p>
              ) : activeJobs.length === 0 ? (
                <p className="text-sm text-gray-500">No active training jobs.</p>
              ) : (
                activeJobs.map((job) => {
                  const progressFromEpoch =
                    typeof job.currentEpoch === "number" && job.epochs
                      ? Math.min(100, Math.round((job.currentEpoch / job.epochs) * 100))
                      : null;
                  const rawProgress = typeof job.progress === "number" ? job.progress : null;
                  const progress =
                    progressFromEpoch !== null
                      ? progressFromEpoch
                      : rawProgress !== null
                        ? Math.min(100, Math.round(rawProgress > 1 ? rawProgress : rawProgress * 100))
                        : 0;
                  const metrics = job.currentMetrics;
                  const startedAt = job.startedAt ? new Date(job.startedAt) : null;
                  const elapsedMinutes = startedAt
                    ? Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 60000))
                    : null;
                  const remainingMinutes =
                    typeof job.estimatedMinutes === "number" && elapsedMinutes !== null
                      ? Math.max(0, job.estimatedMinutes - elapsedMinutes)
                      : null;

                  return (
                    <div
                      key={job.id}
                      className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <p className="text-xs text-gray-500">Dataset</p>
                          <p className="text-base font-semibold text-gray-900">
                            {job.dataset?.name || "Training job"}
                          </p>
                          <p className="text-xs text-gray-500">
                            {job.baseModel} - {job.epochs} epochs
                          </p>
                        </div>
                        <Badge className={STATUS_STYLES[job.status] || "bg-gray-100 text-gray-700"}>
                          {formatStatus(job.status)}
                        </Badge>
                      </div>

                      <div className="mt-4 space-y-2">
                        <Progress value={progress} />
                        <div className="flex items-center justify-between text-xs text-gray-500">
                          <span>
                            {job.currentEpoch ?? 0}/{job.epochs} epochs
                          </span>
                          <span>{progress}%</span>
                        </div>
                      </div>

                      <div className="mt-4 grid gap-2 text-sm md:grid-cols-3">
                        <div className="rounded-md bg-gray-50 px-3 py-2">
                          <p className="text-xs text-gray-500">mAP50</p>
                          <p className="font-semibold">{formatMetric(metrics?.mAP50)}</p>
                        </div>
                        <div className="rounded-md bg-gray-50 px-3 py-2">
                          <p className="text-xs text-gray-500">Precision</p>
                          <p className="font-semibold">{formatMetric(metrics?.precision)}</p>
                        </div>
                        <div className="rounded-md bg-gray-50 px-3 py-2">
                          <p className="text-xs text-gray-500">Recall</p>
                          <p className="font-semibold">{formatMetric(metrics?.recall)}</p>
                        </div>
                      </div>

                      {job.syncStatus === "failed" && (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                          <AlertTriangle className="mt-0.5 h-3 w-3" />
                          <span>
                            Live sync error:{" "}
                            {job.syncError || "Unable to reach EC2. Showing last known data."}
                          </span>
                        </div>
                      )}

                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
                        <div className="text-xs text-gray-500">
                          {elapsedMinutes !== null ? `Elapsed ${elapsedMinutes}m` : "Elapsed --"}
                          {" - "}
                          {remainingMinutes !== null
                            ? `Remaining ${remainingMinutes}m`
                            : job.estimatedMinutes
                              ? `Estimated ${formatMinutes(job.estimatedMinutes)}`
                              : "Remaining --"}
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCancelJob(job.id)}
                          disabled={cancelJobId === job.id}
                        >
                          {cancelJobId === job.id ? "Cancelling..." : "Cancel"}
                        </Button>
                      </div>
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Inference Jobs</CardTitle>
              <CardDescription>Draft detections from custom models.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                <p className="text-sm text-gray-500">Loading inference jobs...</p>
              ) : inferenceJobs.length === 0 ? (
                <p className="text-sm text-gray-500">No inference jobs yet.</p>
              ) : (
                <>
                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Active
                    </p>
                    {activeInferenceJobs.length === 0 ? (
                      <p className="text-sm text-gray-500">No active inference jobs.</p>
                    ) : (
                      activeInferenceJobs.map((job) => {
                        const totalImages = job.config?.totalImages ?? 0;
                        const processedImages = job.config?.processedImages ?? 0;
                        const progress =
                          typeof job.progress === "number"
                            ? Math.min(100, Math.max(0, job.progress))
                            : totalImages > 0
                              ? Math.min(
                                  100,
                                  Math.round((processedImages / totalImages) * 100)
                                )
                              : 0;
                        const statusKey = job.status.toUpperCase();

                        return (
                          <div
                            key={job.id}
                            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="text-xs text-gray-500">Project</p>
                                <p className="text-sm font-semibold text-gray-900">
                                  {job.project.name}
                                </p>
                                <p className="text-xs text-gray-500">
                                  {getInferenceModelLabel(job)}
                                </p>
                              </div>
                              <Badge
                                className={
                                  INFERENCE_STATUS_STYLES[statusKey] ||
                                  "bg-gray-100 text-gray-700"
                                }
                              >
                                {formatStatus(job.status)}
                              </Badge>
                            </div>

                            <div className="mt-3 space-y-2">
                              <Progress value={progress} />
                              <div className="flex items-center justify-between text-xs text-gray-500">
                                <span>
                                  {processedImages}/{totalImages} images
                                </span>
                                <span>{progress}%</span>
                              </div>
                            </div>

                            <div className="mt-3 flex items-center justify-between text-xs text-gray-500">
                              <span>
                                Detections {job.config?.detectionsFound ?? 0}
                              </span>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleCancelInferenceJob(job.id)}
                                disabled={cancelInferenceJobId === job.id}
                              >
                                {cancelInferenceJobId === job.id
                                  ? "Cancelling..."
                                  : "Cancel"}
                              </Button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  <div className="space-y-3">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Recent
                    </p>
                    {recentInferenceJobs.length === 0 ? (
                      <p className="text-sm text-gray-500">No completed inference jobs.</p>
                    ) : (
                      recentInferenceJobs.map((job) => {
                        const statusKey = job.status.toUpperCase();
                        return (
                          <div
                            key={job.id}
                            className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
                          >
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="text-sm font-semibold text-gray-900">
                                  {job.project.name}
                                </p>
                                <p className="text-xs text-gray-500">
                                  {getInferenceModelLabel(job)}
                                </p>
                              </div>
                              <Badge
                                className={
                                  INFERENCE_STATUS_STYLES[statusKey] ||
                                  "bg-gray-100 text-gray-700"
                                }
                              >
                                {formatStatus(job.status)}
                              </Badge>
                            </div>

                            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
                              <span>
                                Detections {job.config?.detectionsFound ?? 0}
                              </span>
                              {job.status === "COMPLETED" ? (
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={() => handleReviewInference(job)}
                                >
                                  Review
                                </Button>
                              ) : null}
                            </div>
                            {job.status === "FAILED" && job.errorMessage ? (
                              <p className="mt-2 text-xs text-red-600">
                                {job.errorMessage}
                              </p>
                            ) : null}
                          </div>
                        );
                      })
                    )}
                  </div>
                </>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Project Inference Settings</CardTitle>
              <CardDescription>
                Configure the active YOLO model and auto-inference per project.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Project</Label>
                  <Select
                    value={settingsProjectId}
                    onValueChange={setSettingsProjectId}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select project" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Auto Inference</Label>
                  <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                    <Checkbox
                      checked={Boolean(selectedSettingsProject?.autoInferenceEnabled)}
                      onCheckedChange={(value) =>
                        handleAutoInferenceToggle(Boolean(value))
                      }
                      disabled={!settingsProjectId || savingAutoInference}
                    />
                    <span className="text-gray-600">
                      Run active model after uploads
                    </span>
                  </div>
                </div>
              </div>
              <div className="rounded-md bg-gray-50 px-3 py-2 text-sm text-gray-600">
                Active model:{" "}
                {activeModelForProject
                  ? activeModelForProject.displayName ||
                    `${activeModelForProject.name} v${activeModelForProject.version}`
                  : "None selected"}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trained Models</CardTitle>
              <CardDescription>Activate a model to use it for detection.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {loading ? (
                <p className="text-sm text-gray-500">Loading models...</p>
              ) : models.length === 0 ? (
                <p className="text-sm text-gray-500">No trained models yet.</p>
              ) : (
                models.map((model) => (
                  <div
                    key={model.id}
                    className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-base font-semibold text-gray-900">
                          {model.displayName || `${model.name} v${model.version}`}
                        </p>
                        {model.isActive && (
                          <Badge className="bg-emerald-100 text-emerald-700">Active</Badge>
                        )}
                        <Badge variant="secondary">{formatStatus(model.status)}</Badge>
                      </div>
                      <p className="text-xs text-gray-500">
                        Trained {formatDate(model.createdAt)} - mAP50{" "}
                        {formatMetric(model.mAP50)}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setSelectedInferenceModel(model);
                          setInferencePreview(null);
                          setRunInferenceOpen(true);
                        }}
                        disabled={
                          !health.available ||
                          !["READY", "ACTIVE"].includes(model.status)
                        }
                      >
                        <PlayCircle className="mr-2 h-4 w-4" />
                        Run on Project
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleActivateModel(model.id)}
                        disabled={
                          !health.available ||
                          !settingsProjectId ||
                          model.isActive ||
                          activatingModelId === model.id
                        }
                      >
                        {activatingModelId === model.id ? (
                          "Activating..."
                        ) : (
                          <>
                            <Rocket className="mr-2 h-4 w-4" />
                            Use for Detection
                          </>
                        )}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => handleDownloadModel(model.id)}
                        disabled={downloadingModelId === model.id}
                      >
                        {downloadingModelId === model.id ? (
                          "Preparing..."
                        ) : (
                          <>
                            <Download className="mr-2 h-4 w-4" />
                            Download weights
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </section>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>Recent Datasets</CardTitle>
              <CardDescription>Latest exports ready for training.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {datasets.length === 0 ? (
                <p className="text-sm text-gray-500">No datasets created yet.</p>
              ) : (
                datasets.slice(0, 5).map((dataset) => (
                  <div
                    key={dataset.id}
                    className="flex flex-col gap-2 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between"
                  >
                    <div>
                      <p className="font-semibold text-gray-900">{dataset.name}</p>
                      <p className="text-xs text-gray-500">
                        {dataset.imageCount} images - {dataset.labelCount} labels -{" "}
                        {dataset.classes.length} classes
                      </p>
                      <p className="text-xs text-gray-500">
                        Train/Val/Test: {dataset.trainCount}/{dataset.valCount}/{dataset.testCount}
                      </p>
                    </div>
                    <Badge variant="secondary">{formatDate(dataset.createdAt)}</Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Service Snapshot</CardTitle>
              <CardDescription>EC2 YOLO runtime status.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {health.loading ? (
                <p className="text-gray-500">Checking service status...</p>
              ) : health.available && health.details ? (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">GPU Available</span>
                    <span className="font-medium">
                      {health.details.gpu_available ? "Yes" : "No"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">GPU Name</span>
                    <span className="font-medium">
                      {health.details.gpu_name || "--"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">Active Jobs</span>
                    <span className="font-medium">
                      {health.details.active_training_jobs}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-600">Cached Models</span>
                    <span className="font-medium">
                      {health.details.cached_models.length}
                    </span>
                  </div>
                </>
              ) : (
                <div className="flex items-start gap-2 text-red-700">
                  <XCircle className="h-4 w-4 mt-0.5" />
                  <div>
                    <p className="font-medium">Service unavailable</p>
                    <p className="text-xs text-red-600">
                      {health.error || "Unable to reach the EC2 YOLO service."}
                    </p>
                  </div>
                </div>
              )}
              <div className="pt-2">
                <Button variant="outline" size="sm" onClick={loadHealth}>
                  <Settings className="mr-2 h-4 w-4" />
                  Recheck Service
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
