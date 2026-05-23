'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Slider } from '@/components/ui/slider';
import { ReviewViewer, type ReviewItem, type ReviewItemAsset } from '@/components/review/ReviewViewer';
import { YOLOConfigModal, type YOLOTrainingConfig } from '@/components/review/YOLOConfigModal';
import { AlertTriangle, Brain, Download, ExternalLink, ShieldCheck, Sparkles } from 'lucide-react';

const REVIEW_DEFAULT_CONFIDENCE = 74;
const REVIEW_CONFIDENCE_PRESETS = [
  {
    label: 'Conservative',
    value: 76,
    description: 'Lower noise',
  },
  {
    label: 'Balanced',
    value: 74,
    description: 'Default QA pass',
  },
  {
    label: 'High recall',
    value: 72,
    description: 'Find more candidates',
  },
  {
    label: 'Exhaustive QA',
    value: 70,
    description: 'Maximum review load',
  },
] as const;

interface ReviewSummary {
  pendingCount: number;
  acceptedCount: number;
  rejectedCount: number;
  exportReadyCount: number;
  totalItemCount: number;
}

interface ReviewSession {
  id: string;
  projectId: string;
  workflowType: string;
  assetCount: number;
  itemsReviewed: number;
  itemsAccepted: number;
  itemsRejected: number;
  roboflowProjectId?: string | null;
  confidenceThreshold?: number | null;
  inferenceJobIds: string[];
  batchJobIds: string[];
  assignedTo?: {
    id: string;
    name?: string | null;
    email?: string | null;
    image?: string | null;
  } | null;
  summary?: ReviewSummary;
}

function ReviewPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');

  const [session, setSession] = useState<ReviewSession | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [assets, setAssets] = useState<ReviewItemAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pendingOnly, setPendingOnly] = useState(false);
  const [pendingOnlyInitialized, setPendingOnlyInitialized] = useState(false);
  const [minConfidence, setMinConfidence] = useState<number>(0);
  const [confidenceInitialized, setConfidenceInitialized] = useState(false);
  const [exportFormat, setExportFormat] = useState<'csv' | 'kml' | 'shapefile'>('csv');
  const [exportIncludeAI, setExportIncludeAI] = useState(true);
  const [exportIncludeManual, setExportIncludeManual] = useState(true);
  const [exportPendingForQa, setExportPendingForQa] = useState(false);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportDefaultsInitialized, setExportDefaultsInitialized] = useState(false);
  const [summary, setSummary] = useState<ReviewSummary | null>(null);

  const [showYoloModal, setShowYoloModal] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(false);
  const [yoloTrainingJobId, setYoloTrainingJobId] = useState<string | null>(null);
  const [assignLoading, setAssignLoading] = useState(false);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/review/${sessionId}`);
    if (!response.ok) {
      throw new Error('Failed to load review session');
    }
    const data = await response.json();
    setSession(data);
    setSummary(data.summary || null);
  }, [sessionId]);

  const loadItems = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/review/${sessionId}/items`);
    if (!response.ok) {
      throw new Error('Failed to load review items');
    }
    const data = await response.json();
    setItems(data.items || []);
    setAssets(data.assets || []);
    if (data.summary) setSummary(data.summary);
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      await Promise.all([loadSession(), loadItems()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load review session');
    } finally {
      setLoading(false);
    }
  }, [loadItems, loadSession, sessionId]);

  useEffect(() => {
    if (sessionId) {
      refresh();
    } else {
      setLoading(false);
      setError('Missing sessionId in URL');
    }
  }, [refresh, sessionId]);

  useEffect(() => {
    if (confidenceInitialized || !session) return;
    if (session.confidenceThreshold != null) {
      setMinConfidence(Math.round(session.confidenceThreshold * 100));
    } else if (session.workflowType === 'batch_review') {
      setMinConfidence(REVIEW_DEFAULT_CONFIDENCE);
    }
    setConfidenceInitialized(true);
  }, [confidenceInitialized, session]);

  useEffect(() => {
    if (pendingOnlyInitialized || !session?.workflowType) return;
    if (session.workflowType === 'batch_review') {
      setPendingOnly(true);
    }
    setPendingOnlyInitialized(true);
  }, [pendingOnlyInitialized, session?.workflowType]);

  useEffect(() => {
    if (exportDefaultsInitialized || !session?.workflowType) return;
    if (session.workflowType === 'batch_review') {
      setExportIncludeAI(false);
    }
    setExportDefaultsInitialized(true);
  }, [exportDefaultsInitialized, session?.workflowType]);

  const filteredItems = useMemo(() => {
    const min = minConfidence > 0 ? minConfidence / 100 : null;
    return items.filter((item) => {
      if (pendingOnly && item.status !== 'pending') return false;
      if (min != null && Number.isFinite(min) && item.confidence < min) return false;
      return true;
    });
  }, [items, minConfidence, pendingOnly]);

  const hasJobScope =
    (session?.inferenceJobIds?.length ?? 0) > 0 || (session?.batchJobIds?.length ?? 0) > 0;
  const replayBundleBatchIds = useMemo(
    () => Array.from(new Set(session?.batchJobIds?.filter(Boolean) ?? [])),
    [session?.batchJobIds]
  );
  const primaryReplayBundleUrl = replayBundleBatchIds[0]
    ? `/api/sam3/v2/batch/${replayBundleBatchIds[0]}/replay-bundle`
    : null;

  const bulkCandidates = useMemo(
    () => filteredItems.filter((item) => item.status === 'pending'),
    [filteredItems]
  );

  const pendingItems = useMemo(
    () => items.filter((item) => item.status === 'pending'),
    [items]
  );

  const pendingVisibleCount = useMemo(() => {
    const min = minConfidence > 0 ? minConfidence / 100 : null;
    return pendingItems.filter((item) => !min || item.confidence >= min).length;
  }, [minConfidence, pendingItems]);

  const pendingHiddenCount = Math.max(0, pendingItems.length - pendingVisibleCount);

  const confidencePresetCounts = useMemo(
    () =>
      REVIEW_CONFIDENCE_PRESETS.map((preset) => ({
        ...preset,
        count: pendingItems.filter((item) => item.confidence >= preset.value / 100).length,
      })),
    [pendingItems]
  );

  const activeConfidencePreset = REVIEW_CONFIDENCE_PRESETS.find(
    (preset) => preset.value === minConfidence
  );

  const availableClasses = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.status !== 'accepted') continue;
      counts.set(item.className, (counts.get(item.className) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  }, [items]);

  const visibleGeoWarningCount = useMemo(
    () => filteredItems.filter((item) => item.status === 'accepted' && !item.hasGeoData).length,
    [filteredItems]
  );

  const handleAction = useCallback(
    async (item: ReviewItem, action: 'accept' | 'reject' | 'correct', correctedClass?: string) => {
      if (!sessionId) return;
      setActionLoading(true);
      setActionError(null);
      try {
        const response = await fetch(`/api/review/${sessionId}/action`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action,
            source: item.source,
            itemId: item.sourceId,
            correctedClass,
          }),
        });

        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || 'Failed to update review item');
        }

        await Promise.all([loadItems(), loadSession()]);
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Failed to update review item');
      } finally {
        setActionLoading(false);
      }
    },
    [loadItems, loadSession, sessionId]
  );

  const handleEdit = useCallback(
    (item: ReviewItem) => {
      if (!sessionId) return;
      const returnTo = encodeURIComponent(`/review?sessionId=${sessionId}`);
      router.push(
        `/annotate/${item.assetId}?highlightId=${item.sourceId}&source=${item.source}&reviewSessionId=${sessionId}&returnTo=${returnTo}`
      );
    },
    [router, sessionId]
  );

  const handleAssign = useCallback(
    async (assigneeId: string | null) => {
      if (!sessionId) return;
      setAssignLoading(true);
      try {
        const response = await fetch(`/api/review/${sessionId}/assign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assigneeId: assigneeId ?? null }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.error || "Failed to assign session");
        }
        await loadSession();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to assign session");
      } finally {
        setAssignLoading(false);
      }
    },
    [loadSession, sessionId]
  );

  const handlePush = useCallback(
    async (target: 'roboflow' | 'yolo', yoloConfig?: YOLOTrainingConfig) => {
      if (!sessionId) return;
      setPushLoading(true);
      setPushError(null);
      setPushMessage(null);
      try {
        const response = await fetch(`/api/review/${sessionId}/push`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            target,
            roboflowProjectId: session?.roboflowProjectId || undefined,
            yoloConfig,
          }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Failed to push review session');
        }

        // Capture YOLO training job ID if available
        if (target === 'yolo' && data.results?.yolo?.trainingJobId) {
          setYoloTrainingJobId(data.results.yolo.trainingJobId);
          setPushMessage(`Training started! Model: ${data.results.yolo.modelName}`);
        } else {
          setPushMessage('Push started successfully.');
        }
      } catch (err) {
        setPushError(err instanceof Error ? err.message : 'Failed to push review session');
      } finally {
        setPushLoading(false);
      }
    },
    [session?.roboflowProjectId, sessionId]
  );

  const handleBulkAccept = useCallback(async () => {
    if (!sessionId || bulkCandidates.length === 0) return;
    if (!window.confirm(`Accept ${bulkCandidates.length} visible pending predictions?`)) return;
    setActionLoading(true);
    setActionError(null);
    try {
      const response = await fetch(`/api/review/${sessionId}/bulk-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'accept',
          items: bulkCandidates.map((item) => ({
            source: item.source,
            itemId: item.sourceId,
          })),
        }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = data.error || 'Failed to accept filtered items';
        throw new Error(message);
      }

      await Promise.all([loadItems(), loadSession()]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to accept filtered items');
    } finally {
      setActionLoading(false);
    }
  }, [bulkCandidates, loadItems, loadSession, sessionId]);

  const handleExport = useCallback(async () => {
    if (!sessionId || exportLoading) return;
    const params = new URLSearchParams({ format: exportFormat, sessionId });
    if (!exportIncludeAI) params.set('includeAI', 'false');
    if (!exportIncludeManual) params.set('includeManual', 'false');
    if (exportPendingForQa) {
      params.set('includePending', 'true');
      params.set('needsReview', 'true');
    }
    if (minConfidence > 0) params.set('minConfidence', (minConfidence / 100).toFixed(4));
    if (exportIncludeAI) {
      params.set('dedupe', 'true');
      params.set('dedupeRadiusM', '1.8');
      params.set('dedupeByClass', 'true');
      params.set('dedupeCrossAssetOnly', 'true');
    }

    setActionError(null);
    setExportLoading(true);
    try {
      const response = await fetch(`/api/export/stream?${params.toString()}`);
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const message = typeof data?.message === 'string'
          ? data.message
          : typeof data?.error === 'string'
            ? data.error
          : `Export failed (HTTP ${response.status})`;
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `review-export-${new Date().toISOString().split('T')[0]}.zip`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to export review results');
    } finally {
      setExportLoading(false);
    }
  }, [exportFormat, exportIncludeAI, exportIncludeManual, exportLoading, exportPendingForQa, minConfidence, sessionId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-6 lg:p-8 text-sm text-gray-500">
        Loading review session...
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 lg:p-8">
        <div className="mx-auto max-w-xl">
          <Card>
            <CardContent className="space-y-4 py-8 text-center">
              <p className="text-sm text-red-600">{error}</p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button asChild variant="outline">
                  <Link href="/training">Back to Training Workspace</Link>
                </Button>
                <Button asChild>
                  <Link href="/dashboard">Go to Dashboard</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mx-auto max-w-[1500px] space-y-6">
        {yoloTrainingJobId && (
          <div className="flex justify-end">
            <Link href="/training">
              <Button variant="outline" size="sm" className="gap-2 border-blue-200 text-blue-600 hover:bg-blue-50">
                <Brain className="h-4 w-4" />
                View training progress
                <ExternalLink className="h-3 w-3" />
              </Button>
            </Link>
          </div>
        )}

        <Card>
          <CardContent className="flex flex-col gap-4 py-6 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Review Session</div>
              <div className="text-lg font-semibold text-gray-900">{session?.id}</div>
              <div className="text-sm text-gray-500">
                {summary?.pendingCount ?? 0} pending · {summary?.acceptedCount ?? 0} accepted ·{' '}
                {summary?.rejectedCount ?? 0} rejected · {summary?.exportReadyCount ?? 0} export-ready
              </div>
            </div>
            <div className="flex flex-col gap-2 text-sm text-gray-600">
              <span>
                Assigned to:{" "}
                <span className="font-medium text-gray-900">
                  {session?.assignedTo?.name ||
                    session?.assignedTo?.email ||
                    "Unassigned"}
                </span>
              </span>
              {!session?.assignedTo && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => handleAssign("me")}
                  disabled={assignLoading}
                >
                  {assignLoading ? "Assigning..." : "Assign to me"}
                </Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={refresh} disabled={loading}>
                Refresh
              </Button>
              <Button
                variant="outline"
                onClick={() => handlePush('roboflow')}
                disabled={pushLoading || !session?.roboflowProjectId}
              >
                Push to Roboflow
              </Button>
              <Button
                onClick={() => setShowYoloModal(true)}
                disabled={pushLoading || availableClasses.length === 0}
              >
                Train model
              </Button>
              {primaryReplayBundleUrl && (
                <Button asChild variant="outline" className="gap-2 border-amber-200 text-amber-700 hover:bg-amber-50">
                  <a href={primaryReplayBundleUrl}>
                    <Download className="h-4 w-4" />
                    {replayBundleBatchIds.length > 1
                      ? `Export replay bundle 1/${replayBundleBatchIds.length}`
                      : 'Export SAM3 replay bundle'}
                  </a>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 md:grid-cols-4">
          {[
            { label: 'Pending', value: summary?.pendingCount ?? 0, className: 'border-amber-200 bg-amber-50 text-amber-800' },
            { label: 'Accepted', value: summary?.acceptedCount ?? 0, className: 'border-green-200 bg-green-50 text-green-800' },
            { label: 'Rejected', value: summary?.rejectedCount ?? 0, className: 'border-gray-200 bg-gray-50 text-gray-800' },
            { label: 'Export-ready', value: summary?.exportReadyCount ?? 0, className: 'border-blue-200 bg-blue-50 text-blue-800' },
          ].map((stat) => (
            <Card key={stat.label} className={stat.className}>
              <CardContent className="py-4">
                <div className="text-xs font-medium uppercase tracking-wide opacity-75">{stat.label}</div>
                <div className="mt-1 text-2xl font-semibold">{stat.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="border-green-200 bg-green-50">
          <CardContent className="flex items-start gap-3 py-4 text-sm text-green-900">
            <ShieldCheck className="mt-0.5 h-5 w-5 flex-shrink-0 text-green-700" />
            <div>
              <div className="font-medium">Spray-safe export is approved-only by default.</div>
              <p className="text-green-800">
                Operational exports include accepted or corrected detections and verified manual annotations.
                Pending review items require the QA checkbox below.
              </p>
            </div>
          </CardContent>
        </Card>

        {session?.workflowType === 'batch_review' && (
          <Card className="border-sky-200 bg-sky-50">
            <CardContent className="py-4 text-sm text-sky-900">
              Recommended flow: accept or correct the SAM3 labels, then export the approved set
              for spray operations. Pending SAM3 detections are excluded from operational exports.
              Accepted items disappear from the list while &quot;Show pending only&quot; is enabled,
              and QA exports of unaccepted items require the amber &quot;Include pending QA items&quot;
              option below.
            </CardContent>
          </Card>
        )}

        {(pushMessage || pushError || actionError) && (
          <div
            className={`rounded-md border px-4 py-2 text-sm ${
              pushError || actionError
                ? 'border-red-200 text-red-600'
                : 'border-emerald-200 text-emerald-600'
            }`}
          >
            {pushError || actionError || pushMessage}
          </div>
        )}

        {items.length === 0 && hasJobScope && (
          <Card className="border-amber-200 bg-amber-50">
            <CardContent className="space-y-3 py-4 text-sm text-amber-700">
              <div>
                <div className="font-medium">No detections found for this review session.</div>
                <p className="mt-1 text-xs text-amber-600">
                  This usually means the inference job finished with zero detections or failed. Diagnostic
                  replay bundles do not require visible annotations, so you can still export the batch inputs
                  for Codex/Williams to replay.
                </p>
              </div>
              {replayBundleBatchIds.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {replayBundleBatchIds.slice(0, 3).map((batchJobId, index) => (
                    <Button
                      key={batchJobId}
                      asChild
                      size="sm"
                      variant="outline"
                      className="gap-2 border-amber-300 bg-white text-amber-800 hover:bg-amber-100"
                    >
                      <a href={`/api/sam3/v2/batch/${batchJobId}/replay-bundle`}>
                        <Download className="h-4 w-4" />
                        {replayBundleBatchIds.length > 1
                          ? `Export replay bundle ${index + 1}`
                          : 'Export SAM3 replay bundle'}
                      </a>
                    </Button>
                  ))}
                  {replayBundleBatchIds.length > 3 && (
                    <span className="self-center text-xs text-amber-600">
                      Showing first 3 of {replayBundleBatchIds.length} batch shards.
                    </span>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card className="border-slate-200 bg-white">
          <CardContent className="space-y-4 py-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div className="space-y-2">
                <div>
                  <div className="text-sm font-semibold text-gray-900">Review sensitivity</div>
                  <p className="max-w-2xl text-xs text-gray-500">
                    Lower the confidence threshold to reveal more SAM3 candidates for QA. This only
                    changes what is visible here; YOLO training and spray export still use accepted
                    or corrected labels only.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {confidencePresetCounts.map((preset) => (
                    <Button
                      key={preset.value}
                      type="button"
                      size="sm"
                      variant={minConfidence === preset.value ? 'default' : 'outline'}
                      onClick={() => setMinConfidence(preset.value)}
                      className="h-auto flex-col items-start gap-0 px-3 py-2 text-left"
                    >
                      <span className="text-xs font-semibold">
                        {preset.label} · {preset.value}%
                      </span>
                      <span className="text-[11px] opacity-80">
                        {preset.count} pending · {preset.description}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>

              <div className="min-w-[260px] rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium">Visible pending</span>
                  <span>{pendingVisibleCount} / {pendingItems.length}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                  <span>Hidden below threshold</span>
                  <span>{pendingHiddenCount}</span>
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 text-xs text-gray-500">
                  <span>Current preset</span>
                  <span>{activeConfidencePreset?.label || 'Custom'}</span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-sm text-gray-600">
              <label className="flex items-center gap-2">
                <Checkbox checked={pendingOnly} onCheckedChange={(value) => setPendingOnly(Boolean(value))} />
                Show pending only
              </label>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span>Min confidence (%)</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={minConfidence}
                    onChange={(event) => {
                      const next = Number(event.target.value);
                      if (!Number.isFinite(next)) return;
                      const clamped = Math.min(100, Math.max(0, next));
                      setMinConfidence(clamped);
                    }}
                    className="h-8 w-20"
                  />
                </div>
                <div className="flex items-center gap-3">
                  <Slider
                    value={[minConfidence]}
                    min={0}
                    max={100}
                    step={1}
                    onValueChange={(value) => setMinConfidence(value[0] ?? 0)}
                    className="w-56"
                  />
                  <span className="text-xs text-gray-500 w-10 text-right">{minConfidence}%</span>
                </div>
              </div>
              {actionLoading && <span className="text-xs text-gray-400">Saving changes...</span>}
              <Button
                variant="outline"
                size="sm"
                onClick={handleBulkAccept}
                disabled={actionLoading || bulkCandidates.length === 0}
              >
                Accept visible pending ({bulkCandidates.length})
              </Button>
              {minConfidence <= 72 && (
                <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
                  High recall mode: expect more false positives to reject.
                </span>
              )}
            </div>
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
          <span className="text-xs uppercase tracking-wide text-gray-500">Export</span>
          <Select
            value={exportFormat}
            onValueChange={(value) => setExportFormat(value as 'csv' | 'kml' | 'shapefile')}
          >
            <SelectTrigger className="h-8 w-36">
              <SelectValue placeholder="Format" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="csv">CSV</SelectItem>
              <SelectItem value="kml">KML</SelectItem>
              <SelectItem value="shapefile">Shapefile</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={exportIncludeManual}
              onCheckedChange={(value) => setExportIncludeManual(Boolean(value))}
            />
            Include manual
          </label>
          <label className="flex items-center gap-2">
            <Checkbox
              checked={exportIncludeAI}
              onCheckedChange={(value) => setExportIncludeAI(Boolean(value))}
            />
            Include AI
          </label>
          <label className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-800">
            <Checkbox
              checked={exportPendingForQa}
              onCheckedChange={(value) => setExportPendingForQa(Boolean(value))}
            />
            Include pending QA items
          </label>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={exportLoading}>
            {exportLoading ? 'Exporting...' : `Export approved ZIP (${summary?.exportReadyCount ?? 0})`}
          </Button>
        </div>

        {visibleGeoWarningCount > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <span>
              {visibleGeoWarningCount} accepted item{visibleGeoWarningCount === 1 ? '' : 's'} in this view
              still need export-time georeferencing. Review item warnings before using the spray file.
            </span>
          </div>
        )}

        <ReviewViewer assets={assets} items={filteredItems} onAction={handleAction} onEdit={handleEdit} />

        {/* Next Steps Card - shown when there are accepted items */}
        {(summary?.acceptedCount ?? 0) > 0 && (
          <Card className="border-green-200 bg-gradient-to-r from-green-50 to-blue-50">
            <CardContent className="py-4">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <div className="flex items-center gap-2 text-sm font-medium text-green-700">
                    <Sparkles className="h-4 w-4" />
                    Ready for next steps
                  </div>
                  <p className="text-xs text-gray-600 mt-1">
                    {summary?.acceptedCount ?? 0} accepted annotations can be exported or used for training.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleExport}
                    disabled={exportLoading}
                    className="gap-2 border-orange-200 text-orange-600 hover:bg-orange-50"
                  >
                    <Download className="h-4 w-4" />
                    {exportLoading ? 'Exporting...' : 'Export for Spray Drones'}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => setShowYoloModal(true)}
                    disabled={availableClasses.length === 0}
                    className="gap-2 bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
                  >
                    <Brain className="h-4 w-4" />
                    Quick train model
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      <YOLOConfigModal
        open={showYoloModal}
        onClose={() => setShowYoloModal(false)}
        availableClasses={availableClasses}
        minConfidence={minConfidence / 100}
        pendingOnly={pendingOnly}
        onPendingOnlyChange={setPendingOnly}
        onConfirm={(config) => {
          setShowYoloModal(false);
          handlePush('yolo', config);
        }}
      />
    </div>
  );
}

export default function ReviewPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center p-6 lg:p-8"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500" /></div>}>
      <ReviewPageContent />
    </Suspense>
  );
}
