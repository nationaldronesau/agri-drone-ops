"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface TrainingStats {
  totalVerified: number;
  pushedToTraining: number;
  pendingPush: number;
  byClass: Record<string, number>;
}

interface PendingAnnotation {
  id: string;
  weedType: string;
}

export default function TrainingPage() {
  const [stats, setStats] = useState<TrainingStats | null>(null);
  const [pending, setPending] = useState<PendingAnnotation[]>([]);
  const [loading, setLoading] = useState(true);
  const [pushing, setPushing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      const [statsRes, pendingRes] = await Promise.all([
        fetch("/api/roboflow/training/stats"),
        fetch("/api/annotations?verified=true&pushedToTraining=false"),
      ]);

      if (!statsRes.ok) {
        throw new Error("Failed to load training stats");
      }

      if (!pendingRes.ok) {
        throw new Error("Failed to load pending annotations");
      }

      const statsData = (await statsRes.json()) as TrainingStats;
      const pendingData = (await pendingRes.json()) as PendingAnnotation[];

      setStats(statsData);
      setPending(pendingData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const pendingCount = pending.length;

  const handlePushAll = async () => {
    if (pendingCount === 0) return;
    try {
      setPushing(true);
      setMessage(null);
      setError(null);

      const response = await fetch("/api/roboflow/training/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          annotationIds: pending.map((item) => item.id),
        }),
      });

      const result = await response.json();
      if (!response.ok) {
        throw new Error(result?.error || "Failed to push annotations");
      }

      setMessage(
        `Pushed ${result.success} annotations. Failed: ${result.failed}.`,
      );
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to push annotations");
    } finally {
      setPushing(false);
    }
  };

  const classEntries = useMemo(() => {
    if (!stats) return [];
    return Object.entries(stats.byClass || {});
  }, [stats]);

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="h-8 w-8 rounded-lg bg-gradient-to-r from-green-500 to-blue-500" />
            <span className="bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-xl font-bold text-transparent">
              Training Pipeline
            </span>
          </div>
          <Link href="/dashboard">
            <Button variant="outline">Back to Dashboard</Button>
          </Link>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-6">
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>Verified Annotations</CardTitle>
              <CardDescription>Total ready for training</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-gray-900">
                {loading ? "…" : stats?.totalVerified ?? 0}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Uploaded for Training</CardTitle>
              <CardDescription>Already pushed</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-semibold text-gray-900">
                {loading ? "…" : stats?.pushedToTraining ?? 0}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Pending Push</CardTitle>
              <CardDescription>Verified but not yet pushed</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-3xl font-semibold text-gray-900">
                {loading ? "…" : stats?.pendingPush ?? pendingCount}
              </p>
              <Button
                className="w-full bg-gradient-to-r from-green-500 to-blue-500 text-white"
                disabled={pushing || pendingCount === 0}
                onClick={handlePushAll}
              >
                {pushing ? "Pushing..." : "Push All Verified"}
              </Button>
              <p className="text-xs text-gray-500">
                This will upload all verified, not-yet-pushed annotations.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Class Distribution</CardTitle>
            <CardDescription>Verified annotations by weed class</CardDescription>
          </CardHeader>
          <CardContent>
            {classEntries.length === 0 ? (
              <p className="text-sm text-gray-500">No verified annotations yet.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {classEntries.map(([className, count]) => (
                  <Badge key={className} variant="secondary">
                    {className}: {count}
                  </Badge>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {message && (
          <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-800">
            {message}
          </div>
        )}
        {error && (
          <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Training Dashboard</CardTitle>
            <CardDescription>
              Monitor uploads and training runs.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Ensure your API key and training project are set in the environment.
            </p>
            <Link
              href="https://app.roboflow.com"
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="outline">View Training Status</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
