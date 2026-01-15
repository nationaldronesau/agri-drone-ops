'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  ArrowLeft,
  Check,
  X,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Upload,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  AlertTriangle,
  Layers,
} from 'lucide-react';
import { InteractiveDetectionOverlay } from '@/components/training/InteractiveDetectionOverlay';

interface PendingAnnotation {
  id: string;
  weedType: string;
  confidence: number;
  similarity?: number | null;
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

interface GroupedByImage {
  assetId: string;
  fileName: string;
  storageUrl: string;
  detections: PendingAnnotation[];
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
}

export default function BatchReviewPage() {
  const params = useParams();
  const batchId = params.batchId as string;
  const router = useRouter();

  const [batchJob, setBatchJob] = useState<BatchJob | null>(null);
  const [annotations, setAnnotations] = useState<PendingAnnotation[]>([]);
  const [summary, setSummary] = useState({ total: 0, pending: 0, accepted: 0, rejected: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [currentImageIndex, setCurrentImageIndex] = useState(0);

  const fetchBatchJob = useCallback(async (options?: { silent?: boolean }) => {
    try {
      const silent = options?.silent;
      if (!silent) setLoading(true);
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
      if (!options?.silent) setLoading(false);
    }
  }, [batchId]);

  useEffect(() => {
    fetchBatchJob();
  }, [fetchBatchJob]);

  // Auto-refresh while processing
  useEffect(() => {
    // Only poll while job is processing or queued
    if (!batchJob || (batchJob.status !== 'PROCESSING' && batchJob.status !== 'QUEUED')) {
      return;
    }

    const intervalId = setInterval(() => {
      fetchBatchJob({ silent: true });
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(intervalId);
  }, [batchJob?.status, fetchBatchJob]);

  // Group annotations by image
  const groupedByImage = useMemo(() => {
    const groups = new Map<string, GroupedByImage>();

    for (const ann of annotations) {
      const assetId = ann.asset.id;
      if (!groups.has(assetId)) {
        groups.set(assetId, {
          assetId,
          fileName: ann.asset.fileName,
          storageUrl: ann.asset.storageUrl,
          detections: [],
          pendingCount: 0,
          acceptedCount: 0,
          rejectedCount: 0,
        });
      }

      const group = groups.get(assetId)!;
      group.detections.push(ann);

      if (ann.status === 'PENDING') group.pendingCount++;
      else if (ann.status === 'ACCEPTED') group.acceptedCount++;
      else if (ann.status === 'REJECTED') group.rejectedCount++;
    }

    return Array.from(groups.values());
  }, [annotations]);

  const currentImage = groupedByImage[currentImageIndex];

  // Update annotation status locally
  const updateAnnotationStatus = (id: string, status: 'ACCEPTED' | 'REJECTED') => {
    setAnnotations(prev => prev.map(a =>
      a.id === id ? { ...a, status } : a
    ));

    // Update summary
    const ann = annotations.find(a => a.id === id);
    if (ann && ann.status === 'PENDING') {
      setSummary(prev => ({
        ...prev,
        pending: prev.pending - 1,
        accepted: status === 'ACCEPTED' ? prev.accepted + 1 : prev.accepted,
        rejected: status === 'REJECTED' ? prev.rejected + 1 : prev.rejected,
      }));
    }
  };

  // Handle accept single annotation
  const handleAccept = async (annotationId: string) => {
    try {
      setProcessing(true);

      const annotation = annotations.find(a => a.id === annotationId);
      if (!annotation || annotation.status !== 'PENDING') return;

      // Create annotation session for this asset
      const sessionRes = await fetch('/api/annotations/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: annotation.asset.id }),
      });

      let sessionId: string | undefined;
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        sessionId = sessionData.id;
      }

      const response = await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: [annotationId],
          action: 'accept',
          sessionId,
        }),
      });

      if (response.ok) {
        updateAnnotationStatus(annotationId, 'ACCEPTED');
      }
    } catch (err) {
      console.error('Failed to accept annotation:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Handle reject single annotation
  const handleReject = async (annotationId: string) => {
    try {
      setProcessing(true);

      const response = await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: [annotationId],
          action: 'reject',
        }),
      });

      if (response.ok) {
        updateAnnotationStatus(annotationId, 'REJECTED');
      }
    } catch (err) {
      console.error('Failed to reject annotation:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Bulk accept all pending in current image
  const handleAcceptAllInImage = async () => {
    if (!currentImage) return;

    const pendingIds = currentImage.detections
      .filter(d => d.status === 'PENDING')
      .map(d => d.id);

    if (pendingIds.length === 0) return;

    try {
      setProcessing(true);

      // Create session for this asset
      const sessionRes = await fetch('/api/annotations/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId: currentImage.assetId }),
      });

      let sessionId: string | undefined;
      if (sessionRes.ok) {
        const sessionData = await sessionRes.json();
        sessionId = sessionData.id;
      }

      const response = await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: pendingIds,
          action: 'accept',
          sessionId,
        }),
      });

      if (response.ok) {
        pendingIds.forEach(id => updateAnnotationStatus(id, 'ACCEPTED'));
      }
    } catch (err) {
      console.error('Failed to bulk accept:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Bulk reject all pending in current image
  const handleRejectAllInImage = async () => {
    if (!currentImage) return;

    const pendingIds = currentImage.detections
      .filter(d => d.status === 'PENDING')
      .map(d => d.id);

    if (pendingIds.length === 0) return;

    try {
      setProcessing(true);

      const response = await fetch('/api/annotations/pending', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          annotationIds: pendingIds,
          action: 'reject',
        }),
      });

      if (response.ok) {
        pendingIds.forEach(id => updateAnnotationStatus(id, 'REJECTED'));
      }
    } catch (err) {
      console.error('Failed to bulk reject:', err);
    } finally {
      setProcessing(false);
    }
  };

  // Navigate between images
  const goToPreviousImage = () => {
    if (currentImageIndex > 0) {
      setCurrentImageIndex(currentImageIndex - 1);
    }
  };

  const goToNextImage = () => {
    if (currentImageIndex < groupedByImage.length - 1) {
      setCurrentImageIndex(currentImageIndex + 1);
    }
  };

  // Auto-advance to next image with pending detections
  const goToNextPendingImage = () => {
    const nextIndex = groupedByImage.findIndex(
      (img, idx) => idx > currentImageIndex && img.pendingCount > 0
    );
    if (nextIndex !== -1) {
      setCurrentImageIndex(nextIndex);
    } else {
      // No more pending, try from start
      const firstPending = groupedByImage.findIndex(img => img.pendingCount > 0);
      if (firstPending !== -1 && firstPending !== currentImageIndex) {
        setCurrentImageIndex(firstPending);
      }
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

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const message = data?.error || response.statusText || 'Failed to upload for training';
        throw new Error(message);
      }

      alert(`Successfully uploaded ${data.pushed} annotations for training!`);
      router.push('/training-hub');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to upload for training');
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

  // Count images with pending detections
  const imagesWithPending = groupedByImage.filter(img => img.pendingCount > 0).length;

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
                  Upload {summary.accepted} for Training
                </Button>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
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

        {batchJob.errorMessage && (
          <Card className="mb-6 border-amber-200 bg-amber-50">
            <CardContent className="py-4">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 mt-0.5" />
                <div className="flex-1">
                  <p className="font-medium text-amber-900">Some images were not processed</p>
                  <p className="text-sm text-amber-700">{batchJob.errorMessage}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary Bar */}
        <div className="grid grid-cols-5 gap-3 mb-6">
          <Card className="bg-white">
            <CardContent className="py-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{groupedByImage.length}</div>
              <div className="text-xs text-gray-500 flex items-center justify-center gap-1">
                <Layers className="w-3 h-3" /> Images
              </div>
            </CardContent>
          </Card>
          <Card className="bg-white">
            <CardContent className="py-3 text-center">
              <div className="text-2xl font-bold text-gray-900">{summary.total}</div>
              <div className="text-xs text-gray-500">Total Detections</div>
            </CardContent>
          </Card>
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="py-3 text-center">
              <div className="text-2xl font-bold text-amber-600">{summary.pending}</div>
              <div className="text-xs text-amber-700 flex items-center justify-center gap-1">
                <Clock className="w-3 h-3" /> Pending
              </div>
            </CardContent>
          </Card>
          <Card className="border-green-200 bg-green-50">
            <CardContent className="py-3 text-center">
              <div className="text-2xl font-bold text-green-600">{summary.accepted}</div>
              <div className="text-xs text-green-700 flex items-center justify-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Accepted
              </div>
            </CardContent>
          </Card>
          <Card className="border-red-200 bg-red-50">
            <CardContent className="py-3 text-center">
              <div className="text-2xl font-bold text-red-600">{summary.rejected}</div>
              <div className="text-xs text-red-700 flex items-center justify-center gap-1">
                <XCircle className="w-3 h-3" /> Rejected
              </div>
            </CardContent>
          </Card>
        </div>

        {groupedByImage.length === 0 ? (
          <Card className="py-12 text-center">
            <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No detections found</h3>
            <p className="text-gray-500">
              {batchJob.status === 'COMPLETED'
                ? 'No predictions were generated for this batch job.'
                : 'Predictions will appear here once processing completes.'}
            </p>
          </Card>
        ) : (
          <div className="grid lg:grid-cols-4 gap-6">
            {/* Image Thumbnails Sidebar */}
            <div className="lg:col-span-1 order-2 lg:order-1">
              <Card className="p-3">
                <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                  <Layers className="w-4 h-4" />
                  Images ({imagesWithPending} with pending)
                </h3>
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {groupedByImage.map((img, idx) => (
                    <button
                      key={img.assetId}
                      onClick={() => setCurrentImageIndex(idx)}
                      className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors text-left ${
                        idx === currentImageIndex
                          ? 'bg-blue-100 border-2 border-blue-500'
                          : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
                      }`}
                    >
                      <div className="w-12 h-12 rounded bg-gray-200 overflow-hidden flex-shrink-0">
                        <img
                          src={img.storageUrl}
                          alt={img.fileName}
                          className="w-full h-full object-cover"
                        />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">{img.fileName}</p>
                        <div className="flex items-center gap-2 mt-1">
                          {img.pendingCount > 0 && (
                            <span className="text-xs text-amber-600 font-medium">
                              {img.pendingCount} pending
                            </span>
                          )}
                          {img.acceptedCount > 0 && (
                            <span className="text-xs text-green-600">✓{img.acceptedCount}</span>
                          )}
                          {img.rejectedCount > 0 && (
                            <span className="text-xs text-red-600">✗{img.rejectedCount}</span>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </Card>
            </div>

            {/* Main Image Viewer */}
            <div className="lg:col-span-3 order-1 lg:order-2">
              {currentImage && (
                <Card className="overflow-hidden">
                  {/* Image Header */}
                  <div className="p-4 border-b bg-gray-50 flex items-center justify-between">
                    <div>
                      <h3 className="font-medium text-gray-900">{currentImage.fileName}</h3>
                      <p className="text-sm text-gray-500">
                        {currentImage.detections.length} detections
                        {currentImage.pendingCount > 0 && (
                          <span className="text-amber-600 ml-2">
                            ({currentImage.pendingCount} pending review)
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={goToPreviousImage}
                        disabled={currentImageIndex === 0}
                      >
                        <ChevronLeft className="w-4 h-4" />
                      </Button>
                      <span className="text-sm text-gray-600">
                        {currentImageIndex + 1} / {groupedByImage.length}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={goToNextImage}
                        disabled={currentImageIndex === groupedByImage.length - 1}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  {/* Interactive Detection Overlay */}
                  <div className="p-4 bg-gray-900">
                    <InteractiveDetectionOverlay
                      imageUrl={currentImage.storageUrl}
                      detections={currentImage.detections}
                      onAccept={handleAccept}
                      onReject={handleReject}
                    />
                  </div>

                  {/* Action Buttons */}
                  <div className="p-4 border-t bg-gray-50 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-gray-600">
                        <span className="inline-flex items-center gap-1 text-amber-600">
                          <Clock className="w-4 h-4" /> {currentImage.pendingCount} pending
                        </span>
                        <span className="mx-2">|</span>
                        <span className="text-green-600">✓ {currentImage.acceptedCount}</span>
                        <span className="mx-1">|</span>
                        <span className="text-red-600">✗ {currentImage.rejectedCount}</span>
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleRejectAllInImage}
                        disabled={processing || currentImage.pendingCount === 0}
                        className="text-red-600 hover:bg-red-50"
                      >
                        <X className="w-4 h-4 mr-1" />
                        Reject All Pending
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleAcceptAllInImage}
                        disabled={processing || currentImage.pendingCount === 0}
                        className="text-green-600 hover:bg-green-50"
                      >
                        <Check className="w-4 h-4 mr-1" />
                        Accept All Pending
                      </Button>
                      <Button
                        size="sm"
                        onClick={goToNextPendingImage}
                        disabled={imagesWithPending === 0 || (imagesWithPending === 1 && currentImage.pendingCount > 0)}
                        className="bg-blue-500 hover:bg-blue-600"
                      >
                        Next with Pending
                        <ChevronRight className="w-4 h-4 ml-1" />
                      </Button>
                    </div>
                  </div>
                </Card>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
