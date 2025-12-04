'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
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
  Check,
  X,
  ChevronLeft,
  ChevronRight,
  Target,
  Loader2,
  CheckCircle2,
  XCircle,
  Edit,
} from 'lucide-react';

interface Detection {
  id: string;
  className: string;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  verified: boolean;
  rejected: boolean;
  userCorrected: boolean;
  originalClass: string | null;
  asset: {
    id: string;
    fileName: string;
    storageUrl: string;
  };
}

interface TrainingSession {
  workflowType: string;
  localProjectId: string;
  roboflowProjectId: string;
  roboflowProject: {
    project: {
      id: string;
      roboflowId: string;
      name: string;
    };
    classes: Array<{
      id: string;
      className: string;
      color: string | null;
    }>;
  };
  confidenceThreshold: number;
}

function ReviewPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('project');

  const [detections, setDetections] = useState<Detection[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [saving, setSaving] = useState(false);

  // Load session from storage
  useEffect(() => {
    const stored = sessionStorage.getItem('trainingSession');
    if (stored) {
      setSession(JSON.parse(stored));
    }
  }, []);

  // Fetch detections
  useEffect(() => {
    if (!projectId || !session) return;

    const fetchDetections = async () => {
      try {
        setLoading(true);
        const response = await fetch(
          `/api/detections?projectId=${projectId}&minConfidence=${session.confidenceThreshold}`
        );
        const data = await response.json();
        setDetections(data.detections || []);
      } catch (err) {
        console.error('Failed to fetch detections:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchDetections();
  }, [projectId, session]);

  const currentDetection = detections[currentIndex];

  const reviewedCount = detections.filter((d) => d.verified || d.rejected).length;
  const progress = detections.length > 0 ? (reviewedCount / detections.length) * 100 : 0;

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex < detections.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handleVerify = async () => {
    if (!currentDetection) return;
    await updateDetection(currentDetection.id, { verified: true, rejected: false });
  };

  const handleReject = async () => {
    if (!currentDetection) return;
    await updateDetection(currentDetection.id, { verified: false, rejected: true });
  };

  const handleCorrectClass = async (newClass: string) => {
    if (!currentDetection) return;
    await updateDetection(currentDetection.id, {
      verified: true,
      rejected: false,
      userCorrected: true,
      originalClass: currentDetection.className,
      className: newClass,
    });
  };

  const updateDetection = async (id: string, updates: Partial<Detection>) => {
    try {
      setSaving(true);
      const response = await fetch(`/api/detections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (!response.ok) {
        throw new Error('Failed to update detection');
      }

      // Update local state
      setDetections((prev) => prev.map((d) => (d.id === id ? { ...d, ...updates } : d)));

      // Auto-advance to next unreviewed
      const nextUnreviewedIndex = detections.findIndex(
        (d, i) => i > currentIndex && !d.verified && !d.rejected
      );
      if (nextUnreviewedIndex !== -1) {
        setCurrentIndex(nextUnreviewedIndex);
      } else if (currentIndex < detections.length - 1) {
        setCurrentIndex(currentIndex + 1);
      }
    } catch (err) {
      console.error('Failed to update detection:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleFinishReview = () => {
    router.push('/training-hub/improve/push');
  };

  if (!projectId || !session) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="p-6 text-center">
          <p className="text-gray-500 mb-4">No project selected</p>
          <Link href="/training-hub/improve">
            <Button>Go Back</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-blue-500 to-blue-600 flex items-center justify-center">
                <Target className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Review Detections</h1>
                <p className="text-sm text-gray-500">{session.roboflowProject.project.name}</p>
              </div>
            </div>
            <Link href="/training-hub/improve">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Setup
              </Button>
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        {/* Progress Steps */}
        <div className="flex items-center justify-center mb-8">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
              <Check className="w-4 h-4" />
            </div>
            <span className="text-sm text-blue-600">Setup</span>
          </div>
          <div className="w-16 h-0.5 bg-blue-500 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
              2
            </div>
            <span className="text-sm font-medium text-blue-600">Review</span>
          </div>
          <div className="w-16 h-0.5 bg-gray-300 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gray-200 text-gray-500 flex items-center justify-center text-sm font-medium">
              3
            </div>
            <span className="text-sm text-gray-500">Push</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : detections.length === 0 ? (
          <Card className="p-8 text-center">
            <Target className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No detections to review</h3>
            <p className="text-gray-500 mb-4">
              Try lowering the confidence threshold or run AI detection on more images.
            </p>
            <Link href="/training-hub/improve">
              <Button>Go Back</Button>
            </Link>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Progress Bar */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">
                  Detection {currentIndex + 1} of {detections.length}
                </span>
                <span className="text-sm text-gray-500">
                  {reviewedCount} / {detections.length} reviewed
                </span>
              </div>
              <Progress value={progress} className="h-2" />
            </Card>

            {/* Detection Viewer */}
            <div className="grid lg:grid-cols-3 gap-6">
              {/* Detection List */}
              <div className="lg:col-span-1">
                <Card className="p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Detections</h3>
                  <div className="space-y-2 max-h-[400px] overflow-y-auto">
                    {detections.map((detection, index) => (
                      <button
                        key={detection.id}
                        onClick={() => setCurrentIndex(index)}
                        className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors ${
                          index === currentIndex
                            ? 'bg-blue-100 border-2 border-blue-500'
                            : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
                        }`}
                      >
                        <div className="w-8 h-8 flex items-center justify-center">
                          {detection.verified && (
                            <CheckCircle2 className="w-5 h-5 text-green-500" />
                          )}
                          {detection.rejected && <XCircle className="w-5 h-5 text-red-500" />}
                          {!detection.verified && !detection.rejected && (
                            <div className="w-5 h-5 rounded-full border-2 border-gray-300" />
                          )}
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <p className="text-sm font-medium truncate">{detection.className}</p>
                          <p className="text-xs text-gray-500">
                            {(detection.confidence * 100).toFixed(0)}% confidence
                          </p>
                        </div>
                        {detection.userCorrected && <Edit className="w-4 h-4 text-amber-500" />}
                      </button>
                    ))}
                  </div>
                </Card>
              </div>

              {/* Main Detection Area */}
              <div className="lg:col-span-2">
                <Card className="overflow-hidden">
                  {currentDetection && (
                    <>
                      <div className="relative aspect-video bg-gray-900">
                        <img
                          src={currentDetection.asset.storageUrl}
                          alt={currentDetection.asset.fileName}
                          className="w-full h-full object-contain"
                        />
                        {/* Bounding box overlay */}
                        <div
                          className="absolute border-2 border-yellow-400"
                          style={{
                            left: `${currentDetection.boundingBox.x}%`,
                            top: `${currentDetection.boundingBox.y}%`,
                            width: `${currentDetection.boundingBox.width}%`,
                            height: `${currentDetection.boundingBox.height}%`,
                          }}
                        >
                          <span className="absolute -top-6 left-0 px-2 py-0.5 bg-yellow-400 text-black text-xs font-medium rounded">
                            {currentDetection.className} (
                            {(currentDetection.confidence * 100).toFixed(0)}%)
                          </span>
                        </div>
                      </div>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between mb-4">
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={handlePrevious}
                              disabled={currentIndex === 0}
                            >
                              <ChevronLeft className="w-4 h-4" />
                            </Button>
                            <Button
                              variant="outline"
                              size="icon"
                              onClick={handleNext}
                              disabled={currentIndex === detections.length - 1}
                            >
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                          </div>

                          <div className="flex items-center gap-2">
                            <Select onValueChange={handleCorrectClass} disabled={saving}>
                              <SelectTrigger className="w-[180px]">
                                <SelectValue placeholder="Correct class" />
                              </SelectTrigger>
                              <SelectContent>
                                {session.roboflowProject.classes.map((cls) => (
                                  <SelectItem key={cls.id} value={cls.className}>
                                    {cls.className}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>

                            <Button
                              variant="outline"
                              onClick={handleReject}
                              disabled={saving || currentDetection.rejected}
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                            >
                              <X className="w-4 h-4 mr-2" />
                              Reject
                            </Button>

                            <Button
                              onClick={handleVerify}
                              disabled={saving || currentDetection.verified}
                              className="bg-green-600 hover:bg-green-700"
                            >
                              <Check className="w-4 h-4 mr-2" />
                              Verify
                            </Button>
                          </div>
                        </div>

                        {currentDetection.userCorrected && currentDetection.originalClass && (
                          <div className="p-2 rounded bg-amber-50 text-amber-700 text-sm">
                            Corrected from &quot;{currentDetection.originalClass}&quot; to &quot;
                            {currentDetection.className}&quot;
                          </div>
                        )}
                      </CardContent>
                    </>
                  )}
                </Card>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-4">
              <Link href="/training-hub/improve">
                <Button variant="outline">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Setup
                </Button>
              </Link>

              <Button
                onClick={handleFinishReview}
                disabled={reviewedCount === 0}
                className="bg-gradient-to-r from-blue-500 to-green-500"
              >
                Continue to Push ({reviewedCount} reviewed)
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function ReviewPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      }
    >
      <ReviewPageContent />
    </Suspense>
  );
}
