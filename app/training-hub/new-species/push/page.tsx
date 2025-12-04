'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import {
  ArrowLeft,
  Check,
  Upload,
  Loader2,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';

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

interface AnnotationSummary {
  total: number;
  byClass: Record<string, number>;
  unpushed: number;
}

export default function PushAnnotationsPage() {
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [summary, setSummary] = useState<AnnotationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [pushProgress, setPushProgress] = useState(0);
  const [pushComplete, setPushComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load session from storage
  useEffect(() => {
    const stored = sessionStorage.getItem('trainingSession');
    if (stored) {
      const parsedSession = JSON.parse(stored);
      setSession(parsedSession);

      // Fetch annotation summary
      fetchAnnotationSummary(parsedSession.localProjectId);
    } else {
      setLoading(false);
    }
  }, []);

  const fetchAnnotationSummary = async (projectId: string) => {
    try {
      // Fetch annotations for the project that haven't been pushed
      const response = await fetch(`/api/annotations?projectId=${projectId}&unpushed=true`);
      const data = await response.json();

      const annotations = data.annotations || [];
      const byClass: Record<string, number> = {};

      for (const ann of annotations) {
        const className = ann.weedType || 'unknown';
        byClass[className] = (byClass[className] || 0) + 1;
      }

      setSummary({
        total: annotations.length,
        byClass,
        unpushed: annotations.filter((a: { pushedToTraining: boolean }) => !a.pushedToTraining).length,
      });
    } catch (err) {
      console.error('Failed to fetch annotations:', err);
      setSummary({ total: 0, byClass: {}, unpushed: 0 });
    } finally {
      setLoading(false);
    }
  };

  const handlePushAnnotations = async () => {
    if (!session) return;

    try {
      setPushing(true);
      setError(null);
      setPushProgress(0);

      // Push annotations to Roboflow with project override
      const response = await fetch('/api/training/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: session.localProjectId,
          roboflowProjectId: session.roboflowProject.project.roboflowId,
          trainValidSplit: 0.8, // 80% train, 20% valid
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to push annotations');
      }

      setPushProgress(100);
      setPushComplete(true);

      // Clear session storage
      sessionStorage.removeItem('trainingSession');
      sessionStorage.removeItem('annotationContext');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to push annotations');
    } finally {
      setPushing(false);
    }
  };

  if (!session && !loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-green-50 via-white to-blue-50">
        <Card className="p-6 text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Training Session</h3>
          <p className="text-gray-500 mb-4">
            Please start the labeling workflow from the beginning.
          </p>
          <Link href="/training-hub/new-species">
            <Button>Start New Session</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 via-white to-blue-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-green-500 to-blue-500 flex items-center justify-center">
                <Upload className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Push to Roboflow</h1>
                <p className="text-sm text-gray-500">Step 3: Upload annotations for training</p>
              </div>
            </div>
            {!pushComplete && (
              <Link href="/training-hub/new-species/label">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Labeling
                </Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
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
              <Check className="w-4 h-4" />
            </div>
            <span className="text-sm text-green-600">Label</span>
          </div>
          <div className="w-16 h-0.5 bg-green-500 mx-2" />
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                pushComplete ? 'bg-green-500 text-white' : 'bg-green-500 text-white'
              }`}
            >
              {pushComplete ? <Check className="w-4 h-4" /> : '3'}
            </div>
            <span className="text-sm font-medium text-green-600">Push</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-green-500" />
          </div>
        ) : pushComplete ? (
          <Card className="p-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h3 className="text-2xl font-bold text-gray-900 mb-2">Annotations Pushed!</h3>
            <p className="text-gray-500 mb-6">
              Your annotations have been uploaded to Roboflow. You can now train a new model
              version.
            </p>

            <div className="flex items-center justify-center gap-4">
              <a
                href={`https://app.roboflow.com/${session?.roboflowProject.project.roboflowId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline">
                  Open in Roboflow
                  <ExternalLink className="w-4 h-4 ml-2" />
                </Button>
              </a>
              <Link href="/training-hub">
                <Button className="bg-gradient-to-r from-green-500 to-blue-500">
                  Back to Training Hub
                </Button>
              </Link>
            </div>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Summary Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Sparkles className="w-5 h-5" />
                  Annotation Summary
                </CardTitle>
                <CardDescription>
                  Review your annotations before pushing to Roboflow.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary && summary.total > 0 ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                      <div>
                        <p className="text-2xl font-bold text-green-900">{summary.total}</p>
                        <p className="text-sm text-green-700">Total annotations</p>
                      </div>
                      <div className="text-right">
                        <p className="text-lg font-semibold text-green-900">{summary.unpushed}</p>
                        <p className="text-sm text-green-700">Ready to push</p>
                      </div>
                    </div>

                    <div>
                      <p className="text-sm font-medium text-gray-700 mb-2">By Class:</p>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(summary.byClass).map(([className, count]) => (
                          <span
                            key={className}
                            className="px-3 py-1 rounded-full bg-gray-100 text-gray-700 text-sm"
                          >
                            {className}: {count as number}
                          </span>
                        ))}
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-3" />
                    <p className="text-gray-600">No annotations found to push.</p>
                    <Link href="/training-hub/new-species/label">
                      <Button variant="outline" className="mt-4">
                        Go Back to Labeling
                      </Button>
                    </Link>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Target Project */}
            {session && (
              <Card>
                <CardHeader>
                  <CardTitle>Target Project</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between p-4 bg-blue-50 rounded-lg">
                    <div>
                      <p className="font-medium text-blue-900">
                        {session.roboflowProject.project.name}
                      </p>
                      <p className="text-sm text-blue-700">
                        {session.roboflowProject.project.roboflowId}
                      </p>
                    </div>
                    <a
                      href={`https://app.roboflow.com/${session.roboflowProject.project.roboflowId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 hover:text-blue-800"
                    >
                      <ExternalLink className="w-5 h-5" />
                    </a>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Push Progress */}
            {pushing && (
              <Card className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-green-500" />
                    <span className="font-medium">Uploading annotations...</span>
                  </div>
                  <Progress value={pushProgress} className="h-2" />
                </div>
              </Card>
            )}

            {/* Error */}
            {error && (
              <Card className="p-4 border-red-200 bg-red-50">
                <div className="flex items-center gap-3 text-red-700">
                  <AlertCircle className="w-5 h-5" />
                  <div>
                    <p className="font-medium">Push Failed</p>
                    <p className="text-sm">{error}</p>
                  </div>
                </div>
              </Card>
            )}

            {/* Action Buttons */}
            <div className="flex items-center justify-between pt-4">
              <Link href="/training-hub/new-species/label">
                <Button variant="outline">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Labeling
                </Button>
              </Link>

              <Button
                onClick={handlePushAnnotations}
                disabled={pushing || !summary || summary.unpushed === 0}
                className="bg-gradient-to-r from-green-500 to-blue-500"
              >
                {pushing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Pushing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Push to Roboflow
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
