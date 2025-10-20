"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { AlertCircle, ArrowLeft, Brain, Upload } from "lucide-react";
import { UppyUploader, type UploadApiResponse } from "@/components/UppyUploader";
import { ROBOFLOW_MODELS } from "@/lib/services/roboflow";

interface Project {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
}

export default function UploadPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [flightSession, setFlightSession] = useState<string>("");
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
      .then((data: Project[]) => {
        setProjects(data);
        if (data.length > 0) {
          setSelectedProject(data[0].id);
        }
      })
      .catch((error) => {
        console.error("Failed to load projects:", error);
        setProcessingError("Unable to load projects. Please try again later.");
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
    return selectedModels
      .map(
        (model) =>
          ROBOFLOW_MODELS[model as keyof typeof ROBOFLOW_MODELS]?.name ?? model,
      )
      .join(", ");
  }, [runDetection, selectedModels]);

  const handleProcessingStart = useCallback(() => {
    setProcessing(true);
    setProcessingError(null);
  }, []);

  const handleProcessingComplete = useCallback((response: UploadApiResponse) => {
    setUploadResponse(response);
    setProcessing(false);

    const successful = response.files.filter((file) => file.success).length;
    const detections = response.files.reduce(
      (total, file) => total + (file.detections?.length ?? 0),
      0,
    );

    if (detections > 0) {
      alert(
        `Success! Uploaded ${successful} files with ${detections} detections.`,
      );
    } else {
      alert(`Success! Uploaded ${successful} files.`);
    }
  }, []);

  const handleProcessingError = useCallback((error: Error) => {
    setProcessing(false);
    setProcessingError(error.message);
  }, []);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/test-dashboard">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="mr-2 h-4 w-4" />
                  Back to Dashboard
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-green-500 to-blue-500" />
                <span className="bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-xl font-bold text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <div className="mx-auto max-w-5xl space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Upload Drone Images</CardTitle>
              <CardDescription>
                Upload imagery directly from the browser to S3, then run EXIF
                parsing and optional AI detection on the backend.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
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
                </div>

                <div className="space-y-4 rounded-lg border border-green-200 bg-green-50 p-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="runDetection"
                      checked={runDetection}
                      onCheckedChange={(checked) =>
                        setRunDetection(Boolean(checked))
                      }
                    />
                    <Label
                      htmlFor="runDetection"
                      className="flex cursor-pointer items-center"
                    >
                      <Brain className="mr-2 h-4 w-4 text-green-600" />
                      Run AI weed detection after upload
                    </Label>
                  </div>

                  {runDetection && (
                    <div className="space-y-3 pl-6">
                      <Label className="text-sm text-gray-600">
                        Select detection models
                      </Label>
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {Object.entries(ROBOFLOW_MODELS).map(([key, model]) => (
                          <div
                            key={key}
                            className={`flex items-center space-x-2 ${model.disabled ? "opacity-60" : ""}`}
                          >
                            <Checkbox
                              id={key}
                              disabled={model.disabled}
                              checked={selectedModels.includes(key)}
                              onCheckedChange={() => toggleModel(key)}
                            />
                            <Label
                              htmlFor={key}
                              className="flex cursor-pointer items-center text-sm"
                            >
                              <span
                                className="mr-2 h-3 w-3 rounded-full"
                                style={{ backgroundColor: model.color }}
                              />
                              {model.name}
                              {model.disabled && (
                                <span className="ml-1 text-xs text-gray-500">
                                  (coming soon)
                                </span>
                              )}
                            </Label>
                          </div>
                        ))}
                      </div>
                      <p className="text-xs text-gray-500">
                        {detectionSummary || "Select at least one model."}
                      </p>
                    </div>
                  )}
                </div>
              </section>

              {!selectedProject && (
                <div className="flex items-center space-x-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <AlertCircle className="h-4 w-4 flex-shrink-0" />
                  <span>Select a project to enable uploads.</span>
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
                      processed server-side.
                    </p>
                  </div>
                </div>
                <UppyUploader
                  projectId={selectedProject || null}
                  runDetection={runDetection}
                  detectionModels={selectedModels}
                  flightSession={flightSession}
                  disabled={!selectedProject}
                  onProcessingStart={handleProcessingStart}
                  onProcessingComplete={handleProcessingComplete}
                  onProcessingError={handleProcessingError}
                />
              </section>

              {processing && (
                <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
                  Processing uploaded files… EXIF parsing and detection may take a
                  moment.
                </div>
              )}

              {processingError && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                  {processingError}
                </div>
              )}

              {uploadResponse && uploadResponse.files.length > 0 && (
                <section className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
                  <h3 className="text-lg font-semibold">
                    Latest Upload Results
                  </h3>

                  <div className="space-y-3">
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
                </section>
              )}

              <section className="rounded-lg border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900">
                <h4 className="mb-2 font-semibold">Pro Tips</h4>
                <ul className="space-y-1">
                  <li>• Ensure your drone captures GPS metadata in each image.</li>
                  <li>• Keep uploads under 500MB per file for best performance.</li>
                  <li>
                    • AI detection runs on the freshly downloaded S3 objects—no
                    local storage required.
                  </li>
                  <li>
                    • The upload summary above includes GPS metadata warnings and
                    detection counts.
                  </li>
                </ul>
              </section>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
