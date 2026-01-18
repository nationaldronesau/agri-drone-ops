'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ArrowLeft,
  ArrowRight,
  Sparkles,
  Upload,
  Loader2,
  Image as ImageIcon,
  FolderOpen,
} from 'lucide-react';
import { RoboflowProjectSelector } from '@/components/training/RoboflowProjectSelector';

interface Project {
  id: string;
  name: string;
  location: string | null;
}

interface RoboflowProject {
  project: {
    id: string;
    roboflowId: string;
    name: string;
    type: string;
    imageCount: number;
  };
  classes: Array<{
    id: string;
    className: string;
    count: number;
    color: string | null;
  }>;
}

export default function NewSpeciesWorkflowPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedRoboflowProjectId, setSelectedRoboflowProjectId] = useState<string>('');
  const [selectedRoboflowProject, setSelectedRoboflowProject] = useState<RoboflowProject | null>(
    null
  );
  const [projectImages, setProjectImages] = useState<number>(0);
  const [loadingImages, setLoadingImages] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  // Fetch local projects
  useEffect(() => {
    const fetchProjects = async () => {
      try {
        const response = await fetch('/api/projects');
        const data = await response.json();
        setProjects(data.projects || []);
      } catch (err) {
        console.error('Failed to fetch projects:', err);
      } finally {
        setLoadingProjects(false);
      }
    };
    fetchProjects();
  }, []);

  // Fetch image count when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setProjectImages(0);
      return;
    }

    const fetchImageCount = async () => {
      setLoadingImages(true);
      try {
        const response = await fetch(`/api/projects/${selectedProjectId}`);
        const data = await response.json();
        setProjectImages(data._count?.assets || 0);
      } catch (err) {
        console.error('Failed to fetch project images:', err);
        setProjectImages(0);
      } finally {
        setLoadingImages(false);
      }
    };
    fetchImageCount();
  }, [selectedProjectId]);

  const handleRoboflowProjectChange = (projectId: string, project: RoboflowProject | null) => {
    setSelectedRoboflowProjectId(projectId);
    setSelectedRoboflowProject(project);
  };

  const canProceed = selectedProjectId && selectedRoboflowProjectId && projectImages > 0;

  const handleStartLabeling = async () => {
    if (!selectedProjectId) return;
    setStarting(true);
    setStartError(null);
    try {
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProjectId,
          workflowType: 'new_species',
          targetType: 'roboflow',
          roboflowProjectId: selectedRoboflowProject?.project?.roboflowId || selectedRoboflowProjectId,
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || 'Failed to create review session');
      }

      const sessionId = data.session?.id;
      if (!sessionId) {
        throw new Error('Review session missing from response');
      }

      const assetsResponse = await fetch(`/api/assets?projectId=${selectedProjectId}`);
      const assetsData = await assetsResponse.json().catch(() => ({}));
      const assets = assetsData.assets || [];
      const firstAsset =
        assets.find((asset: { annotationCount?: number }) => !asset.annotationCount) || assets[0];

      if (!firstAsset) {
        throw new Error('No assets available to annotate');
      }

      router.push(`/annotate/${firstAsset.id}?reviewSessionId=${sessionId}`);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : 'Failed to start workflow');
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-green-500 to-green-600 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Label New Species</h1>
                <p className="text-sm text-gray-500">Step 1: Select source and target</p>
              </div>
            </div>
            <Link href="/training-hub">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Hub
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Progress Steps */}
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center text-sm font-medium">
              1
            </div>
            <span className="text-sm font-medium text-green-600">Setup</span>
          </div>
          <div className="w-16 h-0.5 bg-gray-300 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-sm font-medium">
              2
            </div>
            <span className="text-sm text-gray-500">Label</span>
          </div>
          <div className="w-16 h-0.5 bg-gray-300 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-sm font-medium">
              3
            </div>
            <span className="text-sm text-gray-500">Push</span>
          </div>
        </div>

        <div className="space-y-6">
          {/* Source Images Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5" />
                Source Images
              </CardTitle>
              <CardDescription>
                Select a project with uploaded images to use for labeling. These images should
                contain the species you want to train the AI to detect.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Project</Label>
                {loadingProjects ? (
                  <div className="h-10 bg-gray-100 rounded-md animate-pulse" />
                ) : (
                  <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a project with images" />
                    </SelectTrigger>
                    <SelectContent>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          <div className="flex items-center gap-2">
                            <span>{project.name}</span>
                            {project.location && (
                              <span className="text-xs text-gray-400">({project.location})</span>
                            )}
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {selectedProjectId && (
                <div className="flex items-center gap-4 p-4 rounded-lg bg-gray-50">
                  <ImageIcon className="w-10 h-10 text-gray-400" />
                  <div className="flex-1">
                    {loadingImages ? (
                      <div className="flex items-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span className="text-sm text-gray-500">Loading...</span>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium text-gray-900">
                          {projectImages.toLocaleString()} images available
                        </p>
                        <p className="text-sm text-gray-500">
                          {projectImages === 0
                            ? 'Upload images to this project first'
                            : 'Ready for labeling'}
                        </p>
                      </>
                    )}
                  </div>
                  {projectImages === 0 && (
                    <Link href={`/upload?project=${selectedProjectId}`}>
                      <Button variant="outline" size="sm">
                        <Upload className="w-4 h-4 mr-2" />
                        Upload Images
                      </Button>
                    </Link>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Target Project Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="w-5 h-5" />
                Target Training Project
              </CardTitle>
              <CardDescription>
                Select or create a training project where your annotations will be uploaded. This
                project will be used to train the detection model.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Training Project</Label>
                <RoboflowProjectSelector
                  value={selectedRoboflowProjectId}
                  onChange={handleRoboflowProjectChange}
                  showCreateButton={true}
                />
              </div>

              {selectedRoboflowProject && (
                <div className="p-4 rounded-lg bg-green-50 border border-green-200">
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="font-medium text-green-900">
                        {selectedRoboflowProject.project.name}
                      </p>
                      <p className="text-sm text-green-700">
                        {selectedRoboflowProject.project.type === 'object-detection'
                          ? 'Object Detection'
                          : 'Instance Segmentation'}
                        {' • '}
                        {selectedRoboflowProject.project.imageCount} existing images
                      </p>
                    </div>
                  </div>

                  {selectedRoboflowProject.classes.length > 0 && (
                    <div className="mt-3">
                      <p className="text-xs text-green-700 mb-2">Existing classes:</p>
                      <div className="flex flex-wrap gap-1">
                        {selectedRoboflowProject.classes.map((cls) => (
                          <span
                            key={cls.id}
                            className="px-2 py-0.5 text-xs rounded-full text-white"
                            style={{ backgroundColor: cls.color || '#6b7280' }}
                          >
                            {cls.className}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Action Buttons */}
          <div className="flex items-center justify-between pt-4">
            <Link href="/training-hub">
              <Button variant="outline">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Cancel
              </Button>
            </Link>

            <Button
              onClick={handleStartLabeling}
              disabled={!canProceed || starting}
              className="bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700"
            >
              {starting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Starting...
                </>
              ) : (
                <>
                  Start Labeling
                  <ArrowRight className="w-4 h-4 ml-2" />
                </>
              )}
            </Button>
          </div>

          {startError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {startError}
            </div>
          )}

          {!canProceed && selectedProjectId && projectImages === 0 && (
            <p className="text-center text-sm text-amber-600">
              Please upload images to the selected project before continuing.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
