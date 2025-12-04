'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Sparkles,
  Check,
  Upload,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
  thumbnailUrl: string | null;
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
}

function LabelPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('project');

  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [labeledCount, setLabeledCount] = useState(0);

  // Load session from storage
  useEffect(() => {
    const stored = sessionStorage.getItem('trainingSession');
    if (stored) {
      setSession(JSON.parse(stored));
    }
  }, []);

  // Fetch assets for the project
  useEffect(() => {
    if (!projectId) return;

    const fetchAssets = async () => {
      try {
        setLoading(true);
        const response = await fetch(`/api/assets?projectId=${projectId}`);
        const data = await response.json();
        setAssets(data.assets || []);
      } catch (err) {
        console.error('Failed to fetch assets:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchAssets();
  }, [projectId]);

  const currentAsset = assets[currentIndex];
  const progress = assets.length > 0 ? ((currentIndex + 1) / assets.length) * 100 : 0;

  const handlePrevious = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleNext = () => {
    if (currentIndex < assets.length - 1) {
      setCurrentIndex(currentIndex + 1);
    }
  };

  const handleOpenAnnotator = () => {
    if (currentAsset && session) {
      // Store the Roboflow project context for the annotator
      sessionStorage.setItem(
        'annotationContext',
        JSON.stringify({
          roboflowProjectId: session.roboflowProjectId,
          roboflowProject: session.roboflowProject,
          workflowType: session.workflowType,
        })
      );
      // Open annotator in new tab or navigate
      router.push(`/annotate/${currentAsset.id}?training=true`);
    }
  };

  const handleFinishLabeling = () => {
    router.push('/training-hub/new-species/push');
  };

  if (!projectId) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Card className="p-6 text-center">
          <p className="text-gray-500 mb-4">No project selected</p>
          <Link href="/training-hub/new-species">
            <Button>Go Back</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-green-500 to-green-600 flex items-center justify-center">
                <Sparkles className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Label Images</h1>
                <p className="text-sm text-gray-500">
                  {session?.roboflowProject?.project.name || 'Step 2: Label your images'}
                </p>
              </div>
            </div>
            <Link href="/training-hub/new-species">
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
            <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center text-sm font-medium">
              <Check className="w-4 h-4" />
            </div>
            <span className="text-sm text-green-600">Setup</span>
          </div>
          <div className="w-16 h-0.5 bg-green-500 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center text-sm font-medium">
              2
            </div>
            <span className="text-sm font-medium text-green-600">Label</span>
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
            <Loader2 className="w-8 h-8 animate-spin text-green-500" />
          </div>
        ) : assets.length === 0 ? (
          <Card className="p-8 text-center">
            <ImageIcon className="w-16 h-16 text-gray-300 mx-auto mb-4" />
            <h3 className="text-lg font-medium text-gray-900 mb-2">No images found</h3>
            <p className="text-gray-500 mb-4">
              Upload images to this project before labeling.
            </p>
            <Link href={`/upload?project=${projectId}`}>
              <Button>
                <Upload className="w-4 h-4 mr-2" />
                Upload Images
              </Button>
            </Link>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Progress Bar */}
            <Card className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-700">
                  Image {currentIndex + 1} of {assets.length}
                </span>
                <span className="text-sm text-gray-500">{labeledCount} labeled</span>
              </div>
              <Progress value={progress} className="h-2" />
            </Card>

            {/* Image Display and Navigation */}
            <div className="grid lg:grid-cols-4 gap-6">
              {/* Thumbnail Strip */}
              <div className="lg:col-span-1">
                <Card className="p-4">
                  <h3 className="text-sm font-medium text-gray-700 mb-3">Images</h3>
                  <div className="space-y-2 max-h-[500px] overflow-y-auto">
                    {assets.map((asset, index) => (
                      <button
                        key={asset.id}
                        onClick={() => setCurrentIndex(index)}
                        className={`w-full flex items-center gap-3 p-2 rounded-lg transition-colors ${
                          index === currentIndex
                            ? 'bg-green-100 border-2 border-green-500'
                            : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
                        }`}
                      >
                        <img
                          src={asset.thumbnailUrl || asset.storageUrl}
                          alt={asset.fileName}
                          className="w-12 h-12 object-cover rounded"
                        />
                        <div className="flex-1 text-left min-w-0">
                          <p className="text-sm truncate">{asset.fileName}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </Card>
              </div>

              {/* Main Image Area */}
              <div className="lg:col-span-3">
                <Card className="overflow-hidden">
                  {currentAsset && (
                    <>
                      <div className="relative aspect-video bg-gray-900">
                        <img
                          src={currentAsset.storageUrl}
                          alt={currentAsset.fileName}
                          className="w-full h-full object-contain"
                        />
                      </div>
                      <CardContent className="p-4">
                        <div className="flex items-center justify-between">
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
                              disabled={currentIndex === assets.length - 1}
                            >
                              <ChevronRight className="w-4 h-4" />
                            </Button>
                            <span className="text-sm text-gray-500 ml-2">
                              {currentAsset.fileName}
                            </span>
                          </div>

                          <Button
                            onClick={handleOpenAnnotator}
                            className="bg-gradient-to-r from-green-500 to-green-600"
                          >
                            <Sparkles className="w-4 h-4 mr-2" />
                            Open SAM3 Annotator
                          </Button>
                        </div>
                      </CardContent>
                    </>
                  )}
                </Card>
              </div>
            </div>

            {/* Finish Button */}
            <div className="flex items-center justify-between pt-4">
              <Link href="/training-hub/new-species">
                <Button variant="outline">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Setup
                </Button>
              </Link>

              <Button
                onClick={handleFinishLabeling}
                className="bg-gradient-to-r from-green-500 to-blue-500"
              >
                Continue to Push
                <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default function LabelPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center">
          <Loader2 className="w-8 h-8 animate-spin text-green-500" />
        </div>
      }
    >
      <LabelPageContent />
    </Suspense>
  );
}
