'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Plus,
  RefreshCw,
  Sparkles,
  Target,
  Database,
  ArrowRight,
  Leaf,
  CheckCircle2,
  AlertCircle,
  Wand2,
  Clock,
  Eye,
} from 'lucide-react';
import { CreateProjectDialog } from '@/components/training/CreateProjectDialog';

interface RoboflowClass {
  id: string;
  className: string;
  count: number;
  color: string | null;
}

interface RoboflowProject {
  project: {
    id: string;
    roboflowId: string;
    name: string;
    type: string;
    imageCount: number;
    lastSyncedAt: string;
  };
  classes: RoboflowClass[];
}

interface BatchJob {
  id: string;
  projectId: string;
  weedType: string;
  status: string;
  totalImages: number;
  processedImages: number;
  detectionsFound: number;
  createdAt: string;
  completedAt: string | null;
  _count: {
    pendingAnnotations: number;
  };
  project?: {
    name: string;
  };
}

export default function TrainingHubPage() {
  const [projects, setProjects] = useState<RoboflowProject[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const fetchProjects = async (sync = false) => {
    try {
      if (sync) setSyncing(true);
      else setLoading(true);
      setError(null);

      console.log(`[Training Hub] Fetching projects, sync=${sync}`);
      const response = await fetch(`/api/roboflow/projects${sync ? '?sync=true' : ''}`);

      // Handle non-JSON responses gracefully
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error(`Server returned invalid response (${response.status})`);
      }

      console.log('[Training Hub] API response:', { status: response.status, data });

      if (!response.ok) {
        throw new Error(data?.error || `Failed to fetch projects (${response.status})`);
      }

      // Ensure projects is always an array
      const projects = Array.isArray(data?.projects) ? data.projects : [];
      setProjects(projects);
      console.log(`[Training Hub] Set ${projects.length} projects`);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to load projects';
      console.error('[Training Hub] Error fetching projects:', errorMessage);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };

  const fetchBatchJobs = async () => {
    try {
      // Fetch all batch jobs across projects
      const response = await fetch('/api/sam3/batch/all');
      if (response.ok) {
        const data = await response.json();
        setBatchJobs(data.batchJobs || []);
      }
    } catch (err) {
      console.error('[Training Hub] Error fetching batch jobs:', err);
    }
  };

  useEffect(() => {
    fetchProjects();
    fetchBatchJobs();
  }, []);

  const handleProjectCreated = () => {
    setShowCreateDialog(false);
    fetchProjects(true);
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-green-500 to-blue-500 flex items-center justify-center">
                <Leaf className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-2xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  Training Hub
                </h1>
                <p className="text-sm text-gray-500">Train AI to detect new species</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchProjects(true)}
                disabled={syncing}
              >
                <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                Sync Projects
              </Button>
              <Link href="/dashboard">
                <Button variant="ghost" size="sm">
                  Back to Dashboard
                </Button>
              </Link>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Workflow Cards */}
        <div className="grid md:grid-cols-2 gap-6 mb-8">
          {/* Label New Species */}
          <Card className="hover:shadow-lg transition-all cursor-pointer group border-2 hover:border-green-300">
            <Link href="/training-hub/new-species">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-400 to-green-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Sparkles className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">Label New Species</CardTitle>
                    <CardDescription>Train AI to detect a new weed type</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-gray-600 mb-4">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Upload images without AI detection
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Use SAM3 click-to-segment labeling
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-green-500" />
                    Push annotations to create new model
                  </li>
                </ul>
                <div className="flex items-center text-green-600 font-medium group-hover:gap-3 transition-all">
                  Start Labeling <ArrowRight className="w-4 h-4 ml-2" />
                </div>
              </CardContent>
            </Link>
          </Card>

          {/* Improve Existing Model */}
          <Card className="hover:shadow-lg transition-all cursor-pointer group border-2 hover:border-blue-300">
            <Link href="/training-hub/improve">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                    <Target className="w-6 h-6 text-white" />
                  </div>
                  <div>
                    <CardTitle className="text-xl">Improve Existing Model</CardTitle>
                    <CardDescription>Correct AI mistakes to retrain</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <ul className="space-y-2 text-sm text-gray-600 mb-4">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-blue-500" />
                    Review AI detections from surveys
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-blue-500" />
                    Accept, reject, or correct predictions
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 text-blue-500" />
                    Push corrections to improve model
                  </li>
                </ul>
                <div className="flex items-center text-blue-600 font-medium group-hover:gap-3 transition-all">
                  Start Reviewing <ArrowRight className="w-4 h-4 ml-2" />
                </div>
              </CardContent>
            </Link>
          </Card>
        </div>

        {/* Assisted Labeling Card - Full Width */}
        <Card className="hover:shadow-lg transition-all cursor-pointer group border-2 hover:border-purple-300 mb-8">
          <Link href="/training-hub/new-species">
            <CardHeader className="pb-3">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center group-hover:scale-110 transition-transform">
                  <Wand2 className="w-6 h-6 text-white" />
                </div>
                <div className="flex-1">
                  <CardTitle className="text-xl">Assisted Labeling (SAM3 Batch)</CardTitle>
                  <CardDescription>Label a few exemplars, then apply to entire dataset</CardDescription>
                </div>
                <div className="flex items-center text-purple-600 font-medium group-hover:gap-3 transition-all">
                  Start <ArrowRight className="w-4 h-4 ml-2" />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid md:grid-cols-3 gap-4 text-sm text-gray-600">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center text-xs font-bold">1</span>
                  Label 2-5 examples with SAM3
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center text-xs font-bold">2</span>
                  AI applies predictions to all images
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-purple-100 text-purple-600 flex items-center justify-center text-xs font-bold">3</span>
                  Review & push accepted annotations
                </div>
              </div>
            </CardContent>
          </Link>
        </Card>

        {/* Pending Reviews Section */}
        {batchJobs.length > 0 && (
          <div className="mb-8">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-5 h-5 text-amber-600" />
              <h2 className="text-lg font-semibold text-gray-900">Pending Reviews</h2>
              <span className="px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-700">
                {batchJobs.filter(j => j.status === 'COMPLETED' && j._count.pendingAnnotations > 0).length} awaiting review
              </span>
            </div>
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {batchJobs.filter(j => j._count.pendingAnnotations > 0 || j.status === 'PROCESSING' || j.status === 'QUEUED').slice(0, 6).map((job) => (
                <Link key={job.id} href={`/training-hub/review/${job.id}`}>
                  <Card className="hover:shadow-md transition-shadow cursor-pointer">
                    <CardContent className="py-4">
                      <div className="flex items-start justify-between mb-2">
                        <div>
                          <p className="font-medium text-gray-900">{job.weedType}</p>
                          <p className="text-xs text-gray-500">{job.project?.name || 'Unknown Project'}</p>
                        </div>
                        <span className={`px-2 py-1 text-xs rounded-full ${
                          job.status === 'COMPLETED' ? 'bg-green-100 text-green-700' :
                          job.status === 'PROCESSING' ? 'bg-blue-100 text-blue-700' :
                          job.status === 'FAILED' ? 'bg-red-100 text-red-700' :
                          'bg-gray-100 text-gray-700'
                        }`}>
                          {job.status}
                        </span>
                      </div>
                      <div className="flex items-center justify-between text-sm">
                        <span className="text-gray-600">
                          {job.detectionsFound} detections
                        </span>
                        <span className="text-amber-600 font-medium flex items-center gap-1">
                          <Eye className="w-4 h-4" />
                          {job._count.pendingAnnotations} to review
                        </span>
                      </div>
                      {(job.status === 'PROCESSING' || job.status === 'QUEUED') && (
                        <div className="mt-2">
                          <div className="text-xs text-gray-500 mb-1">
                            {job.processedImages} / {job.totalImages} images
                          </div>
                          <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-500 transition-all"
                              style={{ width: `${(job.processedImages / job.totalImages) * 100}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                </Link>
              ))}
            </div>
          </div>
        )}

        {/* Training Projects Section */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Database className="w-5 h-5 text-gray-600" />
              <h2 className="text-lg font-semibold text-gray-900">Your Training Projects</h2>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCreateDialog(true)}
            >
              <Plus className="w-4 h-4 mr-2" />
              Create New Project
            </Button>
          </div>

          {loading ? (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <Card key={i} className="animate-pulse">
                  <CardHeader>
                    <div className="h-5 bg-gray-200 rounded w-3/4 mb-2" />
                    <div className="h-4 bg-gray-100 rounded w-1/2" />
                  </CardHeader>
                  <CardContent>
                    <div className="h-4 bg-gray-100 rounded w-full mb-2" />
                    <div className="h-4 bg-gray-100 rounded w-2/3" />
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : error ? (
            <Card className="border-red-200 bg-red-50">
              <CardContent className="py-6">
                <div className="flex items-center gap-3 text-red-700">
                  <AlertCircle className="w-5 h-5" />
                  <div>
                    <p className="font-medium">Failed to load projects</p>
                    <p className="text-sm text-red-600">{error}</p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-4"
                  onClick={() => fetchProjects()}
                >
                  <RefreshCw className="w-4 h-4 mr-2" />
                  Retry
                </Button>
              </CardContent>
            </Card>
          ) : projects.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="py-12 text-center">
                <Database className="w-12 h-12 text-gray-300 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">No projects yet</h3>
                <p className="text-gray-500 mb-4">
                  Create a new training project or sync existing ones from your workspace.
                </p>
                <div className="flex items-center justify-center gap-3">
                  <Button
                    variant="outline"
                    onClick={() => fetchProjects(true)}
                    disabled={syncing}
                  >
                    <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
                    Sync Training Data
                  </Button>
                  <Button onClick={() => setShowCreateDialog(true)}>
                    <Plus className="w-4 h-4 mr-2" />
                    Create Project
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((item) => (
                <Card key={item.project.id} className="hover:shadow-md transition-shadow">
                  <CardHeader className="pb-2">
                    <div className="flex items-start justify-between">
                      <div>
                        <CardTitle className="text-base">{item.project.name}</CardTitle>
                        <CardDescription className="text-xs">
                          {item.project.roboflowId}
                        </CardDescription>
                      </div>
                      <span className="px-2 py-1 text-xs rounded-full bg-gray-100 text-gray-600">
                        {item.project.type === 'object-detection' ? 'Detection' : 'Segmentation'}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between text-sm text-gray-600 mb-3">
                      <span>{item.project.imageCount.toLocaleString()} images</span>
                      <span className="text-xs text-gray-400">
                        Synced {new Date(item.project.lastSyncedAt).toLocaleDateString()}
                      </span>
                    </div>
                    {item.classes.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {item.classes.slice(0, 5).map((cls) => (
                          <span
                            key={cls.id}
                            className="px-2 py-0.5 text-xs rounded-full text-white"
                            style={{ backgroundColor: cls.color || '#6b7280' }}
                          >
                            {cls.className} ({cls.count})
                          </span>
                        ))}
                        {item.classes.length > 5 && (
                          <span className="px-2 py-0.5 text-xs rounded-full bg-gray-200 text-gray-600">
                            +{item.classes.length - 5} more
                          </span>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </main>

      {/* Create Project Dialog - only render when open to avoid portal issues */}
      {showCreateDialog && (
        <CreateProjectDialog
          open={showCreateDialog}
          onOpenChange={setShowCreateDialog}
          onSuccess={handleProjectCreated}
        />
      )}
    </div>
  );
}
