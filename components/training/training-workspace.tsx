"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import TrainingClient from "@/components/training/training-client";
import {
  ArrowRight,
  CheckCircle2,
  Clock,
  Database,
  Eye,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  Upload,
  Wand2,
} from "lucide-react";

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
  _count?: {
    pendingAnnotations?: number;
  };
  project?: {
    name: string;
  };
}

const REVIEWABLE_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
const ACTIVE_STATUSES = new Set(["QUEUED", "PROCESSING", "RUNNING", "PREPARING"]);

const statusClassName = (status: string) => {
  switch (status) {
    case "COMPLETED":
      return "bg-emerald-100 text-emerald-700 hover:bg-emerald-100";
    case "PROCESSING":
    case "RUNNING":
      return "bg-blue-100 text-blue-700 hover:bg-blue-100";
    case "FAILED":
      return "bg-red-100 text-red-700 hover:bg-red-100";
    case "CANCELLED":
      return "bg-gray-100 text-gray-700 hover:bg-gray-100";
    default:
      return "bg-amber-100 text-amber-700 hover:bg-amber-100";
  }
};

export function TrainingWorkspace() {
  const [batchJobs, setBatchJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadBatchJobs = useCallback(async (quiet = false) => {
    if (quiet) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const response = await fetch("/api/sam3/batch/all");
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load review work");
      }
      setBatchJobs(Array.isArray(data.batchJobs) ? data.batchJobs : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load review work");
      setBatchJobs([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadBatchJobs();
  }, [loadBatchJobs]);

  const reviewJobs = useMemo(
    () =>
      batchJobs.filter((job) => {
        const pending = job._count?.pendingAnnotations ?? 0;
        return pending > 0 && REVIEWABLE_STATUSES.has(job.status);
      }),
    [batchJobs]
  );

  const activeJobs = useMemo(
    () => batchJobs.filter((job) => ACTIVE_STATUSES.has(job.status)),
    [batchJobs]
  );

  const nextReviewJob = reviewJobs[0] ?? null;
  const pendingReviews = reviewJobs.reduce(
    (sum, job) => sum + (job._count?.pendingAnnotations ?? 0),
    0
  );
  const processedDetections = batchJobs.reduce(
    (sum, job) => sum + Math.max(0, job.detectionsFound || 0),
    0
  );

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-5 px-4 py-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-start gap-4">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-green-500 to-blue-500 text-white">
              <Sparkles className="h-6 w-6" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold text-slate-950">Training Workspace</h1>
                <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">
                  Operator view
                </Badge>
              </div>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                Review AI results, label new species, and manage trained models from one place.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => loadBatchJobs(true)}
              disabled={refreshing}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Button asChild className="bg-gradient-to-r from-green-500 to-blue-500 text-white">
              <Link href={nextReviewJob ? `/training-hub/review/${nextReviewJob.id}` : "/review-queue"}>
                {nextReviewJob ? "Continue next review" : "Open review queue"}
                <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] space-y-6 px-4 py-6 lg:px-8">
        {error ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        ) : null}

        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                Upload &gt; Run Model &gt; Review
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                Select a project, upload images, optionally run the project&apos;s active YOLO model,
                then review candidate detections before they count as accepted labels.
              </p>
            </div>
            <Button asChild className="bg-gradient-to-r from-green-500 to-blue-500 text-white">
              <Link href="/upload">
                <Upload className="mr-2 h-4 w-4" />
                Upload images
              </Link>
            </Button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">1. Upload</p>
              <p className="mt-1 text-sm text-slate-700">S3 upload and asset creation complete first.</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">2. Run model</p>
              <p className="mt-1 text-sm text-slate-700">Active project model runs as a retryable job.</p>
            </div>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <p className="text-xs font-semibold uppercase text-slate-500">3. Review</p>
              <p className="mt-1 text-sm text-slate-700">YOLO boxes and centres remain pending until accepted.</p>
            </div>
          </div>
        </section>

        <section className="grid gap-3 md:grid-cols-3">
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium text-slate-600">Needs review</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">{pendingReviews}</p>
              </div>
              <Eye className="h-8 w-8 text-amber-500" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium text-slate-600">Running now</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">{activeJobs.length}</p>
              </div>
              <Clock className="h-8 w-8 text-blue-500" />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex items-center justify-between p-4">
              <div>
                <p className="text-sm font-medium text-slate-600">Ready to build</p>
                <p className="mt-1 text-2xl font-semibold text-slate-950">{processedDetections}</p>
              </div>
              <Database className="h-8 w-8 text-emerald-500" />
            </CardContent>
          </Card>
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <Card className="border-amber-200">
            <CardHeader>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-amber-100 text-amber-700">
                    <Eye className="h-5 w-5" />
                  </div>
                  <div>
                    <CardTitle>Review AI results</CardTitle>
                    <CardDescription>Check pending SAM3 and model detections.</CardDescription>
                  </div>
                </div>
                {loading ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {reviewJobs.length > 0 ? (
                <div className="space-y-2">
                  {reviewJobs.slice(0, 3).map((job) => (
                    <Link
                      key={job.id}
                      href={`/training-hub/review/${job.id}`}
                      className="block rounded-md border border-slate-200 bg-white px-3 py-2 transition-colors hover:border-amber-300 hover:bg-amber-50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium text-slate-900">
                            {job.weedType || "AI detections"}
                          </p>
                          <p className="truncate text-xs text-slate-500">
                            {job.project?.name || "Project review"}
                          </p>
                        </div>
                        <Badge className={statusClassName(job.status)}>
                          {job._count?.pendingAnnotations ?? 0}
                        </Badge>
                      </div>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-slate-600">
                  No SAM3 batches are waiting right now. Open the queue to review model runs and
                  manual labeling sessions.
                </p>
              )}
              <Button asChild variant="outline" className="w-full justify-between">
                <Link href={nextReviewJob ? `/training-hub/review/${nextReviewJob.id}` : "/review-queue"}>
                  {nextReviewJob ? "Continue review" : "Open review queue"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="border-green-200">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-700">
                  <Wand2 className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Label a new weed/species</CardTitle>
                  <CardDescription>Use uploaded project imagery to create labels.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2 text-sm text-slate-600">
                <p className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Pick one project.
                </p>
                <p className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Label examples with assisted tools.
                </p>
                <p className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  Send accepted labels into training.
                </p>
              </div>
              <Button asChild className="w-full justify-between bg-green-600 hover:bg-green-700">
                <Link href="/training-hub/new-species">
                  Start labeling
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>

          <Card className="border-blue-200">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                  <Target className="h-5 w-5" />
                </div>
                <div>
                  <CardTitle>Train or activate a model</CardTitle>
                  <CardDescription>Build datasets, compare models, and run detections.</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-slate-600">
                Model management now lives below, including training runs, active models per
                project, and detection jobs.
              </p>
              <Button asChild variant="outline" className="w-full justify-between">
                <Link href="#models">
                  Go to models
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        </section>

        <section id="models">
          <TrainingClient workspaceMode />
        </section>
      </main>
    </div>
  );
}
