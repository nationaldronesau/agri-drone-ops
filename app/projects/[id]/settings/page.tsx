"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Settings } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Project {
  id: string;
  name: string;
  activeModelId?: string | null;
  autoInferenceEnabled?: boolean;
  inferenceBackend?: "LOCAL" | "ROBOFLOW" | "AUTO" | null;
}

interface TrainedModel {
  id: string;
  name: string;
  version: number;
  displayName?: string | null;
  mAP50?: number | null;
  status: string;
  isActive?: boolean;
}

export default function ProjectSettingsPage() {
  const params = useParams();
  const projectId = params?.id as string | undefined;

  const [project, setProject] = useState<Project | null>(null);
  const [models, setModels] = useState<TrainedModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingBackend, setSavingBackend] = useState(false);
  const [savingAutoInference, setSavingAutoInference] = useState(false);
  const [activatingModelId, setActivatingModelId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const activeModelId = useMemo(
    () =>
      project?.activeModelId ||
      models.find((model) => model.isActive)?.id ||
      null,
    [project, models]
  );

  const loadProject = async () => {
    if (!projectId) return;
    const response = await fetch(`/api/projects/${projectId}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load project");
    }
    setProject({
      id: data.id,
      name: data.name,
      activeModelId: data.activeModelId,
      autoInferenceEnabled: data.autoInferenceEnabled,
      inferenceBackend: data.inferenceBackend,
    });
  };

  const loadModels = async () => {
    if (!projectId) return;
    const params = new URLSearchParams({ projectId, limit: "200" });
    const response = await fetch(`/api/training/models?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data?.error || "Failed to load trained models");
    }
    setModels(data.models || []);
  };

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    Promise.all([loadProject(), loadModels()])
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load settings"))
      .finally(() => setLoading(false));
  }, [projectId]);

  const handleBackendChange = async (backend: "LOCAL" | "ROBOFLOW" | "AUTO") => {
    if (!projectId) return;
    setSavingBackend(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inferenceBackend: backend }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update inference backend");
      }
      setProject((prev) =>
        prev ? { ...prev, inferenceBackend: data.project?.inferenceBackend ?? backend } : prev
      );
      setNotice(`Inference backend set to ${backend}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update inference backend");
    } finally {
      setSavingBackend(false);
    }
  };

  const handleAutoInferenceToggle = async (enabled: boolean) => {
    if (!projectId) return;
    setSavingAutoInference(true);
    setError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoInferenceEnabled: enabled }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to update auto inference");
      }
      setProject((prev) =>
        prev ? { ...prev, autoInferenceEnabled: data.project?.autoInferenceEnabled } : prev
      );
      setNotice(`Auto inference ${enabled ? "enabled" : "disabled"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update auto inference");
    } finally {
      setSavingAutoInference(false);
    }
  };

  const handleActivateModel = async (modelId: string) => {
    if (!projectId) return;
    setActivatingModelId(modelId);
    setError(null);
    try {
      const response = await fetch(`/api/training/models/${modelId}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await response.json();
      if (!response.ok) {
        const message = data?.details ? `${data.error}: ${data.details}` : data?.error;
        throw new Error(message || "Failed to activate model");
      }
      await Promise.all([loadModels(), loadProject()]);
      setNotice("Active model updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to activate model");
    } finally {
      setActivatingModelId(null);
    }
  };

  if (!projectId) {
    return <div className="p-6 text-sm text-gray-500">Project not found.</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link href="/projects">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Projects
              </Button>
            </Link>
            <div className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-gray-500" />
              <h1 className="text-xl font-semibold text-gray-900">Project Settings</h1>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        {loading ? (
          <div className="text-sm text-gray-500">Loading settings...</div>
        ) : (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Detection Model Settings</CardTitle>
                <CardDescription>
                  Select the active model and inference backend for this project.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {project && (
                  <div className="text-sm text-gray-600">
                    Project: <span className="font-medium text-gray-900">{project.name}</span>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <Label>Inference Backend</Label>
                    <Select
                      value={project?.inferenceBackend || "AUTO"}
                      onValueChange={(value) =>
                        handleBackendChange(value as "LOCAL" | "ROBOFLOW" | "AUTO")
                      }
                      disabled={savingBackend}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select backend" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="AUTO">Auto (Local + Fallback)</SelectItem>
                        <SelectItem value="LOCAL">Local EC2</SelectItem>
                        <SelectItem value="ROBOFLOW">Roboflow</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Auto Inference</Label>
                    <div className="flex items-center gap-2 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm">
                      <Checkbox
                        checked={Boolean(project?.autoInferenceEnabled)}
                        onCheckedChange={(value) => handleAutoInferenceToggle(Boolean(value))}
                        disabled={savingAutoInference}
                      />
                      <span className="text-gray-600">Run active model after uploads</span>
                    </div>
                  </div>
                </div>

                {notice ? (
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                    {notice}
                  </div>
                ) : null}
                {error ? (
                  <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Active Model</CardTitle>
                <CardDescription>Select which trained model powers detections.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {models.length === 0 ? (
                  <div className="text-sm text-gray-500">No trained models available.</div>
                ) : (
                  models.map((model) => {
                    const isActive = activeModelId === model.id;
                    const disabled = !["READY", "ACTIVE"].includes(model.status);
                    return (
                      <div
                        key={model.id}
                        className="flex flex-col gap-3 rounded-lg border border-gray-200 bg-white p-4 shadow-sm md:flex-row md:items-center md:justify-between"
                      >
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-base font-semibold text-gray-900">
                              {model.displayName || `${model.name} v${model.version}`}
                            </p>
                            {isActive && (
                              <Badge className="bg-emerald-100 text-emerald-700">Active</Badge>
                            )}
                            <Badge variant="secondary">{model.status}</Badge>
                          </div>
                          <p className="text-xs text-gray-500">
                            {typeof model.mAP50 === "number"
                              ? `mAP50 ${model.mAP50.toFixed(2)}`
                              : "No metrics yet"}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          onClick={() => handleActivateModel(model.id)}
                          disabled={isActive || disabled || activatingModelId === model.id}
                        >
                          {isActive
                            ? "Active"
                            : activatingModelId === model.id
                              ? "Activating..."
                              : "Set Active"}
                        </Button>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>
          </>
        )}
      </main>
    </div>
  );
}
