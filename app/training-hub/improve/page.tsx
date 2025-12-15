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
import { Slider } from '@/components/ui/slider';
import {
  ArrowLeft,
  ArrowRight,
  Target,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
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

interface DetectionStats {
  total: number;
  verified: number;
  rejected: number;
  pending: number;
  byConfidence: {
    high: number;
    medium: number;
    low: number;
  };
}

export default function ImproveWorkflowPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);

  const [selectedProjectId, setSelectedProjectId] = useState<string>('');
  const [selectedRoboflowProjectId, setSelectedRoboflowProjectId] = useState<string>('');
  const [selectedRoboflowProject, setSelectedRoboflowProject] = useState<RoboflowProject | null>(
    null
  );
  const [confidenceThreshold, setConfidenceThreshold] = useState([0.5]);
  const [stats, setStats] = useState<DetectionStats | null>(null);
  const [loadingStats, setLoadingStats] = useState(false);

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

  // Fetch detection stats when project changes
  useEffect(() => {
    if (!selectedProjectId) {
      setStats(null);
      return;
    }

    const fetchStats = async () => {
      setLoadingStats(true);
      try {
        // Use all=true to get all detections for stats calculation
        const response = await fetch(`/api/detections?projectId=${selectedProjectId}&all=true`);
        const data = await response.json();

        // Calculate stats from detections - API returns array directly when all=true
        const detections = Array.isArray(data) ? data : [];
        const statsData: DetectionStats = {
          total: detections.length,
          verified: detections.filter((d: { verified: boolean }) => d.verified).length,
          rejected: detections.filter((d: { rejected: boolean }) => d.rejected).length,
          pending: detections.filter(
            (d: { verified: boolean; rejected: boolean }) => !d.verified && !d.rejected
          ).length,
          byConfidence: {
            high: detections.filter((d: { confidence: number }) => d.confidence >= 0.8).length,
            medium: detections.filter(
              (d: { confidence: number }) => d.confidence >= 0.5 && d.confidence < 0.8
            ).length,
            low: detections.filter((d: { confidence: number }) => d.confidence < 0.5).length,
          },
        };
        setStats(statsData);
      } catch (err) {
        console.error('Failed to fetch stats:', err);
        setStats(null);
      } finally {
        setLoadingStats(false);
      }
    };
    fetchStats();
  }, [selectedProjectId]);

  const handleRoboflowProjectChange = (projectId: string, project: RoboflowProject | null) => {
    setSelectedRoboflowProjectId(projectId);
    setSelectedRoboflowProject(project);
  };

  const canProceed = selectedProjectId && selectedRoboflowProjectId && stats && stats.total > 0;

  const handleStartReview = () => {
    // Store selected project info in session storage
    sessionStorage.setItem(
      'trainingSession',
      JSON.stringify({
        workflowType: 'IMPROVE_EXISTING',
        localProjectId: selectedProjectId,
        roboflowProjectId: selectedRoboflowProjectId,
        roboflowProject: selectedRoboflowProject,
        confidenceThreshold: confidenceThreshold[0],
      })
    );
    router.push(`/training-hub/improve/review?project=${selectedProjectId}`);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 flex items-center justify-center">
                <Target className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Improve Existing Model</h1>
                <p className="text-sm text-gray-500">Step 1: Select project and model</p>
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
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
              1
            </div>
            <span className="text-sm font-medium text-blue-600">Setup</span>
          </div>
          <div className="w-16 h-0.5 bg-gray-300 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-sm font-medium">
              2
            </div>
            <span className="text-sm text-gray-500">Review</span>
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
          {/* Source Project Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FolderOpen className="w-5 h-5" />
                Source Project
              </CardTitle>
              <CardDescription>
                Select a project that has AI detections you want to review and correct.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Project with Detections</Label>
                {loadingProjects ? (
                  <div className="h-10 bg-gray-100 rounded-md animate-pulse" />
                ) : (
                  <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
                    <SelectTrigger>
                      <SelectValue placeholder="Select a project" />
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
                <div className="p-4 rounded-lg bg-gray-50">
                  {loadingStats ? (
                    <div className="flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span className="text-sm text-gray-500">Loading detection stats...</span>
                    </div>
                  ) : stats ? (
                    <div className="grid grid-cols-4 gap-4 text-center">
                      <div>
                        <p className="text-2xl font-bold text-gray-900">{stats.total}</p>
                        <p className="text-xs text-gray-500">Total</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-amber-600">{stats.pending}</p>
                        <p className="text-xs text-gray-500">Pending</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-green-600">{stats.verified}</p>
                        <p className="text-xs text-gray-500">Verified</p>
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-red-600">{stats.rejected}</p>
                        <p className="text-xs text-gray-500">Rejected</p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-500 text-center">
                      No AI detections found in this project
                    </p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Target Training Project Card */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Target className="w-5 h-5" />
                Target Training Project
              </CardTitle>
              <CardDescription>
                Select the training project to upload verified/corrected annotations to.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Training Project</Label>
                <RoboflowProjectSelector
                  value={selectedRoboflowProjectId}
                  onChange={handleRoboflowProjectChange}
                  showCreateButton={false}
                />
              </div>

              {selectedRoboflowProject && (
                <div className="p-4 rounded-lg bg-blue-50 border border-blue-200">
                  <p className="font-medium text-blue-900">
                    {selectedRoboflowProject.project.name}
                  </p>
                  <p className="text-sm text-blue-700">
                    {selectedRoboflowProject.project.imageCount} existing images
                  </p>

                  {selectedRoboflowProject.classes.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-1">
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
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Confidence Threshold Card */}
          <Card>
            <CardHeader>
              <CardTitle>Review Settings</CardTitle>
              <CardDescription>
                Adjust the confidence threshold to filter which detections to review.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <Label>Confidence Threshold</Label>
                  <span className="text-sm font-medium text-gray-700">
                    {(confidenceThreshold[0] * 100).toFixed(0)}%
                  </span>
                </div>
                <Slider
                  value={confidenceThreshold}
                  onValueChange={setConfidenceThreshold}
                  min={0}
                  max={1}
                  step={0.05}
                  className="w-full"
                />
                <div className="flex items-center justify-between text-xs text-gray-500">
                  <span>Show all</span>
                  <span>High confidence only</span>
                </div>
              </div>

              {stats && (
                <div className="grid grid-cols-3 gap-3 pt-4 border-t">
                  <div className="flex items-center gap-2 p-2 rounded bg-green-50">
                    <CheckCircle2 className="w-4 h-4 text-green-600" />
                    <div>
                      <p className="text-sm font-medium text-green-900">
                        {stats.byConfidence.high}
                      </p>
                      <p className="text-xs text-green-700">High ({'>'}80%)</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded bg-amber-50">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <div>
                      <p className="text-sm font-medium text-amber-900">
                        {stats.byConfidence.medium}
                      </p>
                      <p className="text-xs text-amber-700">Medium (50-80%)</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2 rounded bg-red-50">
                    <XCircle className="w-4 h-4 text-red-600" />
                    <div>
                      <p className="text-sm font-medium text-red-900">{stats.byConfidence.low}</p>
                      <p className="text-xs text-red-700">Low ({'<'}50%)</p>
                    </div>
                  </div>
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
              onClick={handleStartReview}
              disabled={!canProceed}
              className="bg-gradient-to-r from-blue-500 to-blue-600 hover:from-blue-600 hover:to-blue-700"
            >
              Start Reviewing
              <ArrowRight className="w-4 h-4 ml-2" />
            </Button>
          </div>

          {!canProceed && selectedProjectId && stats?.total === 0 && (
            <p className="text-center text-sm text-amber-600">
              No AI detections found in this project. Run AI detection on some images first.
            </p>
          )}
        </div>
      </main>
    </div>
  );
}
