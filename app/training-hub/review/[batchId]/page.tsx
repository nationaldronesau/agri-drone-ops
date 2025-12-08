'use client';

import { useState, useEffect, useCallback, use } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Slider } from '@/components/ui/slider';
import {
  ArrowLeft,
  Check,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Upload,
  Filter,
  Image as ImageIcon,
  AlertTriangle,
} from 'lucide-react';

interface PendingAnnotation {
  id: string;
  weedType: string;
  confidence: number;
  status: 'PENDING' | 'ACCEPTED' | 'REJECTED';
  polygon: number[][];
  bbox: number[];
  centerLat: number | null;
  centerLon: number | null;
  asset: {
    id: string;
    fileName: string;
    storageUrl: string;
    thumbnailUrl: string | null;
  };
}

interface BatchJob {
  id: string;
  projectId: string;
  projectName: string;
  weedType: string;
  status: string;
  totalImages: number;
  processedImages: number;
  detectionsFound: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

interface BatchJobResponse {
  success: boolean;
  batchJob: BatchJob;
  summary: {
    total: number;
    pending: number;
    accepted: number;
    rejected: number;
  };
  annotations: PendingAnnotation[];
}

interface PageProps {
  params: Promise<{ batchId: string }>;
}

export default function BatchReviewPage({ params }: PageProps) {
  const { batchId } = use(params);
  const router = useRouter();

  const [batchJob, setBatchJob] = useState<BatchJob | null>(null);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>([]);
  const [summary, setSummary] = useState({ total: 0, pending: 0, accepted: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [pushing, setPushing] = useState(false);

  // Filters
  const [confidenceThreshold, setConfidenceThreshold] = useState(0);
  const [statusFilter, setStatusFilter] = useState<'all' | 'PENDING' | 'ACCEPTED' | 'REJECTED'>('all');

  const fetchBatchJob = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const response = await fetch(`/api/sam3/batch/${batchId}`);
      const data: BatchJobResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.batchJob ? 'Failed to load batch job' : 'Batch job not found');
      }

      setBatchJob(data.batchJob);
      setAnnotations(data.annotations);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch job');
    } finally {
      setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    fetchBatchJob();
  }, [fetchBatchJob]);

  // Filtered annotations
  const filteredAnnotations = annotations.filter(a => {
    if (a.confidence < confidenceThreshold) return false;
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    return true;
  });

  // Handle accept/reject single annotation
  const handleAction = async (annotationId: string, action: 'accept' | 'reject') => {
    try {
      setProcessing(true);

      // For accept, we need a session - create one on the fly
      let sessionId: string | undefined;
      if (action === 'accept') {
        const annotation = annotations.find(a => a.id === annotationId);
        if (annotation) {
          // Create annotation session for this asset
          const sessionRes = await fetch('/api/annotations/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ assetId: annotation.asset.id }),
          });
          if (sessionRes.ok) {
            const sessionData = await sessionRes.json();
            sessionId = sessionData.session?.id;
          }
        }
      }

      const response = await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: [annotationId],
          action,
          sessionId,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to update annotation');
      }

      // Update local state
      setAnnotations(prev => prev.map(a =>
        a.id === annotationId
          ? { ...a, status: action === 'accept' ? 'ACCEPTED' : 'REJECTED' }
          : a
      ));

      setSummary(prev => ({
        ...prev,
        pending: prev.pending - 1,
        accepted: action === 'accept' ? prev.accepted + 1 : prev.accepted,
        rejected: action === 'reject' ? prev.rejected + 1 : prev.rejected,
      }));
    } catch (err) {
      console.error('Failed to update annotation:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Bulk accept all filtered pending annotations above threshold
  const handleBulkAccept = async () => {
    const pendingAboveThreshold = filteredAnnotations
      .filter(a => a.status === 'PENDING')
      .map(a => a.id);

    if (pendingAboveThreshold.length === 0) return;

    try {
      setProcessing(true);

      // Group by asset to create sessions
      const byAsset = new Map<string, string[]>();
      for (const ann of filteredAnnotations.filter(a => a.status === 'PENDING')) {
        const assetId = ann.asset.id;
        if (!byAsset.has(assetId)) {
          byAsset.set(assetId, []);
        }
        byAsset.get(assetId)!.push(ann.id);
      }

      // Process each asset group
      for (const [assetId, annotationIds] of byAsset) {
        // Create session
        const sessionRes = await fetch('/api/annotations/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ assetId }),
        });

        if (sessionRes.ok) {
          const sessionData = await sessionRes.json();
          const sessionId = sessionData.session?.id;

          // Accept annotations with session
          await fetch('/api/annotations/pending', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              annotationIds,
              action: 'accept',
              sessionId,
            }),
          });
        }
      }

      // Refresh data
      await fetchBatchJob();
    } catch (err) {
      console.error('Failed to bulk accept:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Bulk reject all filtered pending annotations below threshold
  const handleBulkReject = async () => {
    const pendingIds = filteredAnnotations
      .filter(a => a.status === 'PENDING')
      .map(a => a.id);

    if (pendingIds.length === 0) return;

    try {
      setProcessing(true);

      await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: pendingIds,
          action: 'reject',
        }),
      });

      // Refresh data
      await fetchBatchJob();
    } catch (err) {
      console.error('Failed to bulk reject:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Push accepted annotations to Roboflow
  const handlePushToRoboflow = async () => {
    if (!batchJob) return;

    try {
      setPushing(true);

      const response = await fetch('/api/training/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: batchJob.projectId,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to push to Roboflow');
      }

      alert(`Successfully pushed ${data.pushed} annotations to Roboflow!`);
      router.push('/training-hub');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to push to Roboflow');
    } finally {
      setPushing(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-blue-50">
        <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
      </div>
    );
  }

  if (error || !batchJob) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-blue-50">
        <Card className="p-6 text-center max-w-md">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold mb-2">Error Loading Batch Job</h2>
          <p className="text-gray-500 mb-4">{error || 'Batch job not found'}</p>
          <Link href="/training-hub">
            <Button>Back to Training Hub</Button>
          </Link>
        </Card>
      </div>
    );
  }

  const isProcessing = batchJob.status === 'PROCESSING' || batchJob.status === 'QUEUED';
  const progressPercent = batchJob.totalImages > 0
    ? (batchJob.processedImages / batchJob.totalImages) * 100
    : 0;

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Link href="/training-hub">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back
                </Button>
              </Link>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Review Predictions</h1>
                <p className="text-sm text-gray-500">
                  {batchJob.weedType} - {batchJob.projectName}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {summary.accepted > 0 && (
                <Button
                  onClick={handlePushToRoboflow}
                  disabled={pushing}
                  className="bg-gradient-to-r from-green-500 to-blue-500"
                >
                  {pushing ? (
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  ) : (
                    <Upload className="w-4 h-4 mr-2" />
                  )}
                  Push {summary.accepted} to Roboflow
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Processing Status */}
        {isProcessing && (
          <Card className="mb-6 border-blue-200 bg-blue-50">
            <CardContent className="py-4">
              <div className="flex items-center gap-4">
                <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
                <div className="flex-1">
                  <p className="font-medium text-blue-900">Processing images...</p>
                  <p className="text-sm text-blue-700">
                    {batchJob.processedImages} / {batchJob.totalImages} images processed
                  </p>
                  <Progress value={progressPercent} className="mt-2 h-2" />
                </div>
                <Button variant="outline" size="sm" onClick={fetchBatchJob}>
                  Refresh
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary Cards */}
        <div className="grid grid-cols-4 gap-4 mb-6">
          <Card>
            <CardContent className="py-4 text-center">
              <div className="text-3xl font-bold text-gray-900">{summary.total}</div>
              <div className="text-sm text-gray-500">Total Detections</div>
            </CardContent>
          </Card>
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="py-4 text-center">
              <div className="text-3xl font-bold text-amber-600">{summary.pending}</div>
              <div className="text-sm text-amber-700 flex items-center justify-center gap-1">
                <Clock className="w-4 h-4" /> Pending
              </div>
            </CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50">
            <CardContent className="py-4 text-center">
              <div className="text-3xl font-bold text-green-600">{summary.accepted}</div>
              <div className="text-sm text-green-700 flex items-center justify-center gap-1">
                <CheckCircle2 className="w-4 h-4" /> Accepted
              </div>
            </CardContent>
          </Card>
          <Card className="border-red-200 bg-red-50">
            <CardContent className="py-4 text-center">
              <div className="text-3xl font-bold text-red-600">{summary.rejected}</div>
              <div className="text-sm text-red-700 flex items-center justify-center gap-1">
                <XCircle className="w-4 h-4" /> Rejected
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Filters and Bulk Actions */}
        <Card className="mb-6">
          <CardContent className="py-4">
            <div className="flex flex-wrap items-center gap-6">
              {/* Confidence Filter */}
              <div className="flex items-center gap-3 min-w-[300px]">
                <Filter className="w-4 h-4 text-gray-500" />
                <span className="text-sm text-gray-600 whitespace-nowrap">
                  Min Confidence: {(confidenceThreshold * 100).toFixed(0)}%
                </span>
                <Slider
                  value={[confidenceThreshold]}
                  onValueChange={([v]) => setConfidenceThreshold(v)}
                  min={0}
                  max={1}
                  step={0.05}
                  className="w-32"
                />
              </div>

              {/* Status Filter */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-600">Status:</span>
                <div className="flex gap-1">
                  {(['all', 'PENDING', 'ACCEPTED', 'REJECTED'] as const).map(status => (
                    <Button
                      key={status}
                      variant={statusFilter === status ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setStatusFilter(status)}
                    >
                      {status === 'all' ? 'All' : status.charAt(0) + status.slice(1).toLowerCase()}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Bulk Actions */}
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkReject}
                  disabled={processing || filteredAnnotations.filter(a => a.status === 'PENDING').length === 0}
                  className="text-red-600 hover:bg-red-50"
                >
                  <X className="w-4 h-4 mr-1" />
                  Reject {filteredAnnotations.filter(a => a.status === 'PENDING').length} Pending
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleBulkAccept}
                  disabled={processing || filteredAnnotations.filter(a => a.status === 'PENDING').length === 0}
                  className="text-green-600 hover:bg-green-50"
                >
                  <Check className="w-4 h-4 mr-1" />
                  Accept {filteredAnnotations.filter(a => a.status === 'PENDING').length} Pending
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Annotations Grid */}
        {filteredAnnotations.length === 0 ? (
          <Card className="py-12 text-center">
            <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No detections match filters</h3>
            <p className="text-gray-500">
              {annotations.length === 0
                ? 'No predictions found in this batch job yet.'
                : 'Try adjusting the confidence threshold or status filter.'}
            </p>
          </Card>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            {filteredAnnotations.map(annotation => (
              <Card
                key={annotation.id}
                className={`overflow-hidden transition-all ${
                  annotation.status === 'ACCEPTED' ? 'ring-2 ring-green-500' :
                  annotation.status === 'REJECTED' ? 'ring-2 ring-red-500 opacity-60' :
                  'hover:shadow-lg'
                }`}
              >
                <div className="relative aspect-square bg-gray-100">
                  <img
                    src={annotation.asset.thumbnailUrl || annotation.asset.storageUrl}
                    alt={annotation.asset.fileName}
                    className="w-full h-full object-cover"
                  />
                  {/* Confidence badge */}
                  <div className={`absolute top-2 left-2 px-2 py-1 rounded text-xs font-medium ${
                    annotation.confidence >= 0.8 ? 'bg-green-500 text-white' :
                    annotation.confidence >= 0.5 ? 'bg-yellow-500 text-white' :
                    'bg-red-500 text-white'
                  }`}>
                    {(annotation.confidence * 100).toFixed(0)}%
                  </div>
                  {/* Status badge */}
                  <div className="absolute top-2 right-2">
                    {annotation.status === 'ACCEPTED' && (
                      <CheckCircle2 className="w-6 h-6 text-green-500 bg-white rounded-full" />
                    )}
                    {annotation.status === 'REJECTED' && (
                      <XCircle className="w-6 h-6 text-red-500 bg-white rounded-full" />
                    )}
                  </div>
                </div>
                <CardContent className="p-3">
                  <p className="text-sm font-medium truncate mb-2">{annotation.weedType}</p>
                  <p className="text-xs text-gray-500 truncate mb-2">{annotation.asset.fileName}</p>
                  {annotation.status === 'PENDING' && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="flex-1 text-red-600 hover:bg-red-50"
                        onClick={() => handleAction(annotation.id, 'reject')}
                        disabled={processing}
                      >
                        <X className="w-4 h-4" />
                      </Button>
                      <Button
                        size="sm"
                        className="flex-1 bg-green-600 hover:bg-green-700"
                        onClick={() => handleAction(annotation.id, 'accept')}
                        disabled={processing}
                      >
                        <Check className="w-4 h-4" />
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
