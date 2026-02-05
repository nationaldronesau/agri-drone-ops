"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, RefreshCw } from "lucide-react";

interface TrainingJobSummary {
  id: string;
  status: string;
  trainedModel?: {
    id: string;
    name: string;
    version: number;
    mAP50?: number | null;
  } | null;
}

interface DatasetVersion {
  id: string;
  name: string;
  displayName?: string | null;
  version?: number | null;
  imageCount: number;
  labelCount: number;
  annotationCount?: number | null;
  classes: string[];
  status: string;
  createdAt: string;
  trainingJobs?: TrainingJobSummary[];
}

interface ProjectInfo {
  id: string;
  name: string;
  totalImages: number;
  totalAnnotations: number;
}

interface PreviewData {
  imageCount: number;
  labelCount: number;
  trainCount: number;
  valCount: number;
  testCount: number;
  classCounts: Record<string, number>;
  availableClasses: Array<{ name: string; count: number }>;
}

interface DatasetVersionsResponse {
  versions: DatasetVersion[];
  project: ProjectInfo;
  featureEnabled: boolean;
}

interface CreateFormState {
  displayName: string;
  classes: string;
  includeAIDetections: boolean;
  includeManual: boolean;
  includeSAM3: boolean;
  verifiedOnly: boolean;
  minConfidence: number;
  splitTrain: number;
  splitVal: number;
  splitTest: number;
  resize: string;
  autoOrient: boolean;
  tile: string;
  augmentationFlip: boolean;
  augmentationRotation: number;
  augmentationBrightness: number;
  augmentationMultiplier: number;
}

const DEFAULT_FORM: CreateFormState = {
  displayName: "",
  classes: "",
  includeAIDetections: true,
  includeManual: true,
  includeSAM3: false,
  verifiedOnly: false,
  minConfidence: 0.5,
  splitTrain: 80,
  splitVal: 15,
  splitTest: 5,
  resize: "640",
  autoOrient: true,
  tile: "",
  augmentationFlip: true,
  augmentationRotation: 15,
  augmentationBrightness: 0,
  augmentationMultiplier: 1,
};

const STATUS_STYLES: Record<string, string> = {
  CREATING: "bg-amber-100 text-amber-700",
  READY: "bg-emerald-100 text-emerald-700",
  TRAINING: "bg-blue-100 text-blue-700",
  FAILED: "bg-red-100 text-red-700",
  ARCHIVED: "bg-gray-100 text-gray-600",
};

function formatStatus(status: string) {
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function parseClasses(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function generateIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function DatasetVersions({ projectId }: { projectId: string }) {
  const [versions, setVersions] = useState<DatasetVersion[]>([]);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CreateFormState>({ ...DEFAULT_FORM });
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(generateIdempotencyKey());

  const fetchVersions = async () => {
    try {
      setLoading(true);
      setError(null);
      const response = await fetch(`/api/projects/${projectId}/versions`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to load dataset versions");
      }
      const data = (await response.json()) as DatasetVersionsResponse;
      setVersions(data.versions || []);
      setProject(data.project || null);
      setFeatureEnabled(Boolean(data.featureEnabled));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load dataset versions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchVersions();
  }, [projectId]);

  useEffect(() => {
    if (createOpen) {
      setIdempotencyKey(generateIdempotencyKey());
    }
  }, [createOpen]);

  useEffect(() => {
    if (!createOpen || !featureEnabled) return;

    const timeout = setTimeout(async () => {
      try {
        setPreviewLoading(true);
        const splits = {
          train: form.splitTrain / 100,
          val: form.splitVal / 100,
          test: form.splitTest / 100,
        };
        const filters = {
          includeAIDetections: form.includeAIDetections,
          includeManual: form.includeManual,
          includeSAM3: form.includeSAM3,
          verifiedOnly: form.verifiedOnly,
          minConfidence: form.minConfidence,
          weedTypes: parseClasses(form.classes),
        };
        const response = await fetch(`/api/projects/${projectId}/versions/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ splits, filters, classes: parseClasses(form.classes) }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to preview dataset");
        }
        const data = await response.json();
        setPreview(data.preview || null);
      } catch (err) {
        console.error(err);
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 400);

    return () => clearTimeout(timeout);
  }, [createOpen, featureEnabled, form, projectId]);

  const splitTotal = useMemo(
    () => form.splitTrain + form.splitVal + form.splitTest,
    [form.splitTrain, form.splitVal, form.splitTest]
  );

  const handleCreate = async () => {
    try {
      setCreating(true);
      setError(null);

      const splits = {
        train: form.splitTrain / 100,
        val: form.splitVal / 100,
        test: form.splitTest / 100,
      };

      const filters = {
        includeAIDetections: form.includeAIDetections,
        includeManual: form.includeManual,
        includeSAM3: form.includeSAM3,
        verifiedOnly: form.verifiedOnly,
        minConfidence: form.minConfidence,
        weedTypes: parseClasses(form.classes),
      };

      const preprocessing = {
        resize: form.resize || undefined,
        tile: form.tile || undefined,
        autoOrient: form.autoOrient,
      };

      const augmentation = {
        flip: form.augmentationFlip,
        rotation: form.augmentationRotation,
        brightness: form.augmentationBrightness,
        multiplier: form.augmentationMultiplier,
      };

      const response = await fetch(`/api/projects/${projectId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey,
          displayName: form.displayName || undefined,
          splits,
          filters,
          classes: parseClasses(form.classes),
          preprocessing,
          augmentation,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to create dataset version");
      }

      setCreateOpen(false);
      setForm({ ...DEFAULT_FORM });
      setPreview(null);
      await fetchVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create dataset version");
    } finally {
      setCreating(false);
    }
  };

  if (loading) {
    return (
      <div className="py-10 text-center text-sm text-gray-500">Loading dataset versions...</div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-2xl font-semibold text-gray-900">Dataset Versions</h2>
          <p className="text-sm text-gray-500">
            {project ? `Project: ${project.name}` : "Manage frozen dataset versions"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchVersions}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Refresh
          </Button>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button disabled={!featureEnabled}>
                <Plus className="w-4 h-4 mr-2" />
                New Version
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-3xl">
              <DialogHeader>
                <DialogTitle>Create Dataset Version</DialogTitle>
                <DialogDescription>
                  Freeze a snapshot of annotated data for reproducible YOLO training.
                </DialogDescription>
              </DialogHeader>

              {!featureEnabled ? (
                <div className="rounded-md border border-amber-200 bg-amber-50 p-4 text-sm text-amber-700">
                  Dataset versioning is disabled for this project. Enable it in project features to
                  continue.
                </div>
              ) : (
                <div className="grid gap-6 md:grid-cols-2">
                  <div className="space-y-4">
                    <div>
                      <Label htmlFor="displayName">Version Name</Label>
                      <Input
                        id="displayName"
                        placeholder="March 2026 Release"
                        value={form.displayName}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, displayName: event.target.value }))
                        }
                      />
                    </div>

                    <div>
                      <Label htmlFor="classes">Classes (optional)</Label>
                      <Input
                        id="classes"
                        placeholder="wattle, lantana, pine"
                        value={form.classes}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, classes: event.target.value }))
                        }
                      />
                      <p className="mt-1 text-xs text-gray-500">
                        Leave blank to include all available classes.
                      </p>
                    </div>

                    <div className="grid grid-cols-3 gap-2">
                      <div>
                        <Label>Train %</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={form.splitTrain}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              splitTrain: Number(event.target.value),
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Val %</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={form.splitVal}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              splitVal: Number(event.target.value),
                            }))
                          }
                        />
                      </div>
                      <div>
                        <Label>Test %</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          value={form.splitTest}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              splitTest: Number(event.target.value),
                            }))
                          }
                        />
                      </div>
                      <div className="col-span-3 text-xs text-gray-500">
                        Total: {splitTotal}% (should sum to 100%)
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label>Filters</Label>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={form.includeAIDetections}
                          onCheckedChange={(value) =>
                            setForm((prev) => ({ ...prev, includeAIDetections: Boolean(value) }))
                          }
                        />
                        <span className="text-sm">Include AI detections</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={form.includeManual}
                          onCheckedChange={(value) =>
                            setForm((prev) => ({ ...prev, includeManual: Boolean(value) }))
                          }
                        />
                        <span className="text-sm">Include manual annotations</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={form.includeSAM3}
                          onCheckedChange={(value) =>
                            setForm((prev) => ({ ...prev, includeSAM3: Boolean(value) }))
                          }
                        />
                        <span className="text-sm">Include SAM3 (accepted)</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          checked={form.verifiedOnly}
                          onCheckedChange={(value) =>
                            setForm((prev) => ({ ...prev, verifiedOnly: Boolean(value) }))
                          }
                        />
                        <span className="text-sm">Verified only</span>
                      </div>
                      <div>
                        <Label htmlFor="minConfidence">Min confidence</Label>
                        <Input
                          id="minConfidence"
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={form.minConfidence}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              minConfidence: Number(event.target.value),
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>

                  <div className="space-y-4">
                    <div>
                      <Label>Preprocessing</Label>
                      <div className="grid gap-2">
                        <Select
                          value={form.resize}
                          onValueChange={(value) => setForm((prev) => ({ ...prev, resize: value }))}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Resize" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="640">640 x 640</SelectItem>
                            <SelectItem value="1024">1024 x 1024</SelectItem>
                            <SelectItem value="1280">1280 x 1280</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={form.autoOrient}
                            onCheckedChange={(value) =>
                              setForm((prev) => ({ ...prev, autoOrient: Boolean(value) }))
                            }
                          />
                          <span className="text-sm">Auto-orient images</span>
                        </div>
                        <Input
                          placeholder="Tile grid (optional)"
                          value={form.tile}
                          onChange={(event) =>
                            setForm((prev) => ({ ...prev, tile: event.target.value }))
                          }
                        />
                      </div>
                    </div>

                    <div>
                      <Label>Augmentation</Label>
                      <div className="grid gap-2">
                        <Select
                          value={String(form.augmentationMultiplier)}
                          onValueChange={(value) =>
                            setForm((prev) => ({
                              ...prev,
                              augmentationMultiplier: Number(value),
                            }))
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Multiplier" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="1">1x</SelectItem>
                            <SelectItem value="2">2x</SelectItem>
                            <SelectItem value="3">3x</SelectItem>
                            <SelectItem value="5">5x</SelectItem>
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-2">
                          <Checkbox
                            checked={form.augmentationFlip}
                            onCheckedChange={(value) =>
                              setForm((prev) => ({ ...prev, augmentationFlip: Boolean(value) }))
                            }
                          />
                          <span className="text-sm">Horizontal flip</span>
                        </div>
                        <Input
                          type="number"
                          min={0}
                          max={45}
                          value={form.augmentationRotation}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              augmentationRotation: Number(event.target.value),
                            }))
                          }
                          placeholder="Rotation (deg)"
                        />
                        <Input
                          type="number"
                          min={0}
                          max={1}
                          step={0.05}
                          value={form.augmentationBrightness}
                          onChange={(event) =>
                            setForm((prev) => ({
                              ...prev,
                              augmentationBrightness: Number(event.target.value),
                            }))
                          }
                          placeholder="Brightness (0-1)"
                        />
                      </div>
                    </div>

                    <div className="rounded-md border border-gray-200 p-4 text-sm text-gray-600">
                      <div className="flex items-center justify-between">
                        <span>Preview</span>
                        {previewLoading && <span className="text-xs">Updating...</span>}
                      </div>
                      {preview ? (
                        <div className="mt-2 space-y-1">
                          <div>Images: {preview.imageCount}</div>
                          <div>Annotations: {preview.labelCount}</div>
                          <div>
                            Split: {preview.trainCount} / {preview.valCount} / {preview.testCount}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-gray-500">
                          Preview unavailable.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {error && <p className="text-sm text-red-600">{error}</p>}

              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleCreate} disabled={!featureEnabled || creating}>
                  {creating ? "Creating..." : "Create Version"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {!featureEnabled && (
        <Card className="border-amber-200 bg-amber-50">
          <CardContent className="py-4 text-sm text-amber-700">
            Dataset versioning is disabled for this project. Enable it to start creating
            reproducible versions.
          </CardContent>
        </Card>
      )}

      {error && !createOpen && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-4 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      {versions.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-gray-500">
            No dataset versions created yet.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {versions.map((version) => {
            const latestJob = version.trainingJobs?.[0];
            return (
              <Card key={version.id}>
                <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <CardTitle className="text-lg">
                      v{version.version ?? "?"} {version.displayName || version.name}
                    </CardTitle>
                    <CardDescription>
                      {new Date(version.createdAt).toLocaleDateString()} · {version.imageCount} images
                    </CardDescription>
                  </div>
                  <Badge className={STATUS_STYLES[version.status] || "bg-gray-100 text-gray-600"}>
                    {formatStatus(version.status)}
                  </Badge>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="flex flex-wrap gap-2 text-sm text-gray-600">
                    <span>{version.classes.length} classes</span>
                    <span>•</span>
                    <span>{version.labelCount} labels</span>
                    {version.annotationCount != null && (
                      <>
                        <span>•</span>
                        <span>{version.annotationCount} annotations</span>
                      </>
                    )}
                  </div>

                  {latestJob?.trainedModel && (
                    <div className="rounded-md border border-gray-200 px-3 py-2 text-sm">
                      Latest model: {latestJob.trainedModel.name}-v{latestJob.trainedModel.version}
                      {typeof latestJob.trainedModel.mAP50 === "number" && (
                        <span className="ml-2 text-gray-500">
                          mAP50 {latestJob.trainedModel.mAP50.toFixed(2)}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="flex flex-wrap gap-2">
                    <Link href={`/training?datasetId=${version.id}`}>
                      <Button size="sm">Train New Model</Button>
                    </Link>
                    <Button size="sm" variant="outline" disabled>
                      Compare
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
