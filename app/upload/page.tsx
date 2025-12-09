"use client";

import { useCallback, useEffect, useState } from "react";
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
import { AlertCircle, ArrowLeft, Brain, Upload, Map, Images, Tags, ArrowRight, CheckCircle2 } from "lucide-react";
import { UppyUploader, type UploadApiResponse } from "@/components/UppyUploader";
import { ModelSelector, type RoboflowModel } from "@/components/detection/ModelSelector";

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
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [availableModels, setAvailableModels] = useState<RoboflowModel[]>([]);
  const [processing, setProcessing] = useState<boolean>(false);
  const [processingError, setProcessingError] = useState<string | null>(null);
  const [uploadResponse, setUploadResponse] = useState<UploadApiResponse | null>(
    null,
  );

  // Fetch available models
  useEffect(() => {
    fetch("/api/roboflow/models")
      .then((res) => res.json())
      .then((data) => {
        if (data.models) {
          setAvailableModels(data.models);
        }
      })
      .catch((error) => {
        console.error("Failed to load models:", error);
      });
  }, []);

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
        console.error("Failed to load projects:", error);
        setProcessingError("Unable to load projects. Please try again later.");
      });
  }, []);

  // Get selected models data for the UppyUploader
  const selectedModelsData = availableModels.filter((m) =>
    selectedModelIds.includes(m.id)
  );

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

                <div className="space-y-4">
                  <div className="flex items-center space-x-2 rounded-lg border border-green-200 bg-green-50 p-4">
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
                    <ModelSelector
                      selectedModels={selectedModelIds}
                      onSelectionChange={setSelectedModelIds}
                      disabled={!selectedProject}
                    />
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
                  dynamicModels={selectedModelsData}
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
                          {uploadResponse.files.filter(f => f.success !== false).length} of {uploadResponse.files.length} images uploaded successfully
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* Next Steps */}
                  <section className="rounded-lg border-2 border-green-300 bg-gradient-to-r from-green-50 to-blue-50 p-6">
                    <h3 className="mb-4 text-lg font-semibold text-gray-800">
                      What would you like to do next?
                    </h3>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
                      <Link href="/map">
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
