"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { AlertCircle, Upload } from "lucide-react";
import {
  UppyUploader,
  type UploadApiResponse,
} from "@/components/UppyUploader";
import { ROBOFLOW_MODELS } from "@/lib/services/roboflow";

interface Project {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
}

export function ImageUpload() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [runDetection, setRunDetection] = useState<boolean>(true);
  const [selectedModels, setSelectedModels] = useState<string[]>(() =>
    Object.keys(ROBOFLOW_MODELS).filter(
      (key) => !ROBOFLOW_MODELS[key as keyof typeof ROBOFLOW_MODELS].disabled,
    ),
  );
  const [processing, setProcessing] = useState<boolean>(false);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [uploadResponse, setUploadResponse] = useState<UploadApiResponse | null>(
    null,
  );

  useEffect(() => {
    fetch("/api/projects")
      .then((res) => res.json())
      .then((data) => {
        const projectList = data.projects || [];
        setProjects(projectList);
        if (projectList.length > 0) {
          setSelectedProject(projectList[0].id);
        }
      })
      .catch((error) => {
        console.error("Unable to fetch projects:", error);
        setProcessingError("Failed to load projects. Please refresh the page.");
      });
  }, []);

  const toggleModel = useCallback((model: string) => {
    setSelectedModels((prev) =>
      prev.includes(model) ? prev.filter((m) => m !== model) : [...prev, model],
    );
  }, []);

  const detectionSummary = useMemo(() => {
    if (!runDetection) {
      return "AI detection disabled.";
    }
    if (selectedModels.length === 0) {
      return "Select at least one detection model.";
    }
    return selectedModels
      .map(
        (model) =>
          ROBOFLOW_MODELS[model as keyof typeof ROBOFLOW_MODELS]?.name ?? model,
      )
      .join(", ");
  }, [runDetection, selectedModels]);

  const onProcessingStart = useCallback(() => {
    setProcessing(true);
    setProcessingError(null);
  }, []);

  const onProcessingComplete = useCallback((response: UploadApiResponse) => {
    setProcessing(false);
    setUploadResponse(response);
  }, []);

  const onProcessingError = useCallback((error: Error) => {
    setProcessing(false);
    setProcessingError(error.message);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-xl">Quick Upload</CardTitle>
        <CardDescription>
          Upload imagery straight to S3. Processing runs after the files land in
          the bucket.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="dashboard-project">Project</Label>
            <Select
              value={selectedProject}
              onValueChange={setSelectedProject}
            >
              <SelectTrigger id="dashboard-project">
                <SelectValue placeholder="Select a project" />
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

          <div className="space-y-3 rounded-lg border border-green-200 bg-green-50 p-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="dashboard-run-detection"
                checked={runDetection}
                onCheckedChange={(checked) => setRunDetection(Boolean(checked))}
              />
              <Label
                htmlFor="dashboard-run-detection"
                className="flex cursor-pointer items-center"
              >
                <Upload className="mr-2 h-4 w-4 text-green-600" />
                Run AI detection
              </Label>
            </div>

            {runDetection && (
              <div className="space-y-2 pl-6">
                <p className="text-xs text-gray-600">
                  Choose which models to run:
                </p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {Object.entries(ROBOFLOW_MODELS).map(([key, model]) => (
                    <div
                      key={key}
                      className={`flex items-center space-x-2 ${model.disabled ? "opacity-60" : ""}`}
                    >
                      <Checkbox
                        id={`dashboard-model-${key}`}
                        disabled={model.disabled}
                        checked={selectedModels.includes(key)}
                        onCheckedChange={() => toggleModel(key)}
                      />
                      <Label
                        htmlFor={`dashboard-model-${key}`}
                        className="flex cursor-pointer items-center text-xs"
                      >
                        <span
                          className="mr-2 h-3 w-3 rounded-full"
                          style={{ backgroundColor: model.color }}
                        />
                        {model.name}
                      </Label>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500">{detectionSummary}</p>
              </div>
            )}
          </div>
        </section>

        {!selectedProject && (
          <div className="flex items-center space-x-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>Select a project before uploading files.</span>
          </div>
        )}

        <UppyUploader
          projectId={selectedProject || null}
          runDetection={runDetection}
          detectionModels={selectedModels}
          disabled={!selectedProject}
          onProcessingStart={onProcessingStart}
          onProcessingComplete={onProcessingComplete}
          onProcessingError={onProcessingError}
        />

        {processing && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900">
            Processing uploaded files… metadata parsing and detections are in
            progress.
          </div>
        )}

        {processingError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-800">
            {processingError}
          </div>
        )}

        {uploadResponse && uploadResponse.files.length > 0 && (
          <>
            <h4 className="text-sm font-semibold">Latest Results</h4>
            <div className="space-y-3">
              {uploadResponse.files.map((file) => (
                <div
                  key={`${file.name}-${file.url}`}
                  className="rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-700"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium">{file.name}</span>
                    <span>{file.size?.toLocaleString()} bytes</span>
                  </div>
                  <p className="truncate text-gray-500">{file.url}</p>
                  {file.warning && (
                    <p className="mt-2 text-yellow-700">{file.warning}</p>
                  )}
                  {file.error && (
                    <p className="mt-2 text-red-700">{file.error}</p>
                  )}
                  {file.detections && file.detections.length > 0 && (
                    <p className="mt-2 text-green-700">
                      {file.detections.length} detections saved.
                    </p>
                  )}
                </div>
              ))}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setUploadResponse(null)}
            >
              Clear Results
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
