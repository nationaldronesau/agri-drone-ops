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
  Target,
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Edit,
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

interface ReviewSummary {
  verified: number;
  rejected: number;
  corrected: number;
  total: number;
}

export default function PushCorrectionsPage() {
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);
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
      fetchReviewSummary(parsedSession.localProjectId);
    } else {
      setLoading(false);
    }
  }, []);

  const fetchReviewSummary = async (projectId: string) => {
    try {
      // Use all=true to get all detections for summary calculation
      const response = await fetch(`/api/detections?projectId=${projectId}&all=true`);
      const data = await response.json();

      // API returns array directly when all=true
      const detections = Array.isArray(data) ? data : [];
      setSummary({
        verified: detections.filter(
          (d: { verified: boolean; userCorrected: boolean }) => d.verified && !d.userCorrected
        ).length,
        rejected: detections.filter((d: { rejected: boolean }) => d.rejected).length,
        corrected: detections.filter((d: { userCorrected: boolean }) => d.userCorrected).length,
        total: detections.filter(
          (d: { verified: boolean; rejected: boolean }) => d.verified || d.rejected
        ).length,
      });
    } catch (err) {
      console.error('Failed to fetch review summary:', err);
      setSummary({ verified: 0, rejected: 0, corrected: 0, total: 0 });
    } finally {
      setLoading(false);
    }
  };

  const handlePushCorrections = async () => {
    if (!session) return;

    try {
      setPushing(true);
      setError(null);
      setPushProgress(0);

      // Push verified detections to Roboflow with project override
      const response = await fetch('/api/training/push-detections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: session.localProjectId,
          roboflowProjectId: session.roboflowProject.project.roboflowId,
          includeVerified: true,
          includeCorrected: true,
          trainValidSplit: 0.8,
        }),
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const message = data?.error || response.statusText || 'Failed to push corrections';
        throw new Error(message);
      }

      setPushProgress(100);
      setPushComplete(true);

      // Clear session storage
      sessionStorage.removeItem('trainingSession');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to push corrections');
    } finally {
      setPushing(false);
    }
  };

  if (!session && !loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-blue-50 via-white to-green-50">
        <Card className="p-6 text-center max-w-md">
          <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No Training Session</h3>
          <p className="text-gray-500 mb-4">
            Please start the review workflow from the beginning.
          </p>
          <Link href="/training-hub/improve">
            <Button>Start New Session</Button>
          </Link>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-white to-green-50">
      {/* Header */}
      <header className="bg-white/80 backdrop-blur-sm border-b sticky top-0 z-10">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-gradient-to-r from-blue-500 to-green-500 flex items-center justify-center">
                <Upload className="w-6 h-6 text-white" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-gray-900">Push Corrections</h1>
                <p className="text-sm text-gray-500">Step 3: Upload reviewed detections</p>
              </div>
            </div>
            {!pushComplete && (
              <Link href="/training-hub/improve/review">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Review
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
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
              <Check className="w-4 h-4" />
            </div>
            <span className="text-sm text-blue-600">Setup</span>
          </div>
          <div className="w-16 h-0.5 bg-blue-500 mx-2" />
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-blue-500 text-white flex items-center justify-center text-sm font-medium">
              <Check className="w-4 h-4" />
            </div>
            <span className="text-sm text-blue-600">Review</span>
          </div>
          <div className="w-16 h-0.5 bg-blue-500 mx-2" />
          <div className="flex items-center gap-2">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                pushComplete ? 'bg-green-500 text-white' : 'bg-blue-500 text-white'
              }`}
            >
              {pushComplete ? <Check className="w-4 h-4" /> : '3'}
            </div>
            <span className="text-sm font-medium text-blue-600">Push</span>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
          </div>
        ) : pushComplete ? (
          <Card className="p-8 text-center">
            <CheckCircle2 className="w-16 h-16 text-green-500 mx-auto mb-4" />
            <h3 className="text-2xl font-bold text-gray-900 mb-2">Corrections Uploaded!</h3>
            <p className="text-gray-500 mb-6">
              Your reviewed detections have been uploaded for training. The model can now be
              retrained with the corrections.
            </p>

            <div className="flex items-center justify-center gap-4">
              <a
                href={`https://app.roboflow.com/${session?.roboflowProject.project.roboflowId}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button variant="outline">
                  View Training Status
                  <ExternalLink className="w-4 h-4 ml-2" />
                </Button>
              </a>
              <Link href="/training-hub">
                <Button className="bg-gradient-to-r from-blue-500 to-green-500">
                  Back to Training Hub
                </Button>
              </Link>
            </div>
          </Card>
        ) : (
          <div className="space-y-6">
            {/* Review Summary Card */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Target className="w-5 h-5" />
                  Review Summary
                </CardTitle>
                <CardDescription>
                  Summary of reviewed detections ready to upload for training.
                </CardDescription>
              </CardHeader>
              <CardContent>
                {summary && summary.total > 0 ? (
                  <div className="grid grid-cols-3 gap-4">
                    <div className="p-4 bg-green-50 rounded-lg text-center">
                      <CheckCircle2 className="w-8 h-8 text-green-500 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-green-900">{summary.verified}</p>
                      <p className="text-sm text-green-700">Verified</p>
                    </div>
                    <div className="p-4 bg-amber-50 rounded-lg text-center">
                      <Edit className="w-8 h-8 text-amber-500 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-amber-900">{summary.corrected}</p>
                      <p className="text-sm text-amber-700">Corrected</p>
                    </div>
                    <div className="p-4 bg-red-50 rounded-lg text-center">
                      <AlertCircle className="w-8 h-8 text-red-500 mx-auto mb-2" />
                      <p className="text-2xl font-bold text-red-900">{summary.rejected}</p>
                      <p className="text-sm text-red-700">Rejected</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8">
                    <AlertCircle className="w-12 h-12 text-amber-500 mx-auto mb-3" />
                    <p className="text-gray-600">No reviewed detections found.</p>
                    <Link href="/training-hub/improve/review">
                      <Button variant="outline" className="mt-4">
                        Go Back to Review
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
                    <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
                    <span className="font-medium">Uploading corrections...</span>
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
              <Link href="/training-hub/improve/review">
                <Button variant="outline">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Review
                </Button>
              </Link>

              <Button
                onClick={handlePushCorrections}
                disabled={pushing || !summary || summary.total === 0}
                className="bg-gradient-to-r from-blue-500 to-green-500"
              >
                {pushing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Pushing...
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    Upload for Training
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
