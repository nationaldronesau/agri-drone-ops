'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { ReviewViewer, type ReviewItem } from '@/components/review/ReviewViewer';
import { YOLOConfigModal, type YOLOTrainingConfig } from '@/components/review/YOLOConfigModal';

interface ReviewSession {
  id: string;
  projectId: string;
  assetCount: number;
  itemsReviewed: number;
  itemsAccepted: number;
  itemsRejected: number;
  roboflowProjectId?: string | null;
  confidenceThreshold?: number | null;
  inferenceJobIds: string[];
  batchJobIds: string[];
}

function ReviewPageContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('sessionId');

  const [session, setSession] = useState<ReviewSession | null>(null);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [pendingOnly, setPendingOnly] = useState(false);
  const [minConfidence, setMinConfidence] = useState<number>(0);

  const [showYoloModal, setShowYoloModal] = useState(false);
  const [pushMessage, setPushMessage] = useState<string | null>(null);
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushLoading, setPushLoading] = useState(false);

  const loadSession = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/review/${sessionId}`);
    if (!response.ok) {
      throw new Error('Failed to load review session');
    }
    const data = await response.json();
    setSession(data);
  }, [sessionId]);

  const loadItems = useCallback(async () => {
    if (!sessionId) return;
    const response = await fetch(`/api/review/${sessionId}/items`);
    if (!response.ok) {
      throw new Error('Failed to load review items');
    }
    const data = await response.json();
    setItems(data.items || []);
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
    if (session?.confidenceThreshold != null && minConfidence === 0) {
      setMinConfidence(Math.round(session.confidenceThreshold * 100));
    }
  }, [minConfidence, session?.confidenceThreshold]);

  const filteredItems = useMemo(() => {
    const min = minConfidence > 0 ? minConfidence / 100 : null;
    return items.filter((item) => {
      if (pendingOnly && item.status !== 'pending') return false;
      if (min != null && Number.isFinite(min) && item.confidence < min) return false;
      return true;
    });
  }, [items, minConfidence, pendingOnly]);

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

        setPushMessage('Push started successfully.');
      } catch (err) {
        setPushError(err instanceof Error ? err.message : 'Failed to push review session');
      } finally {
        setPushLoading(false);
      }
    },
    [session?.roboflowProjectId, sessionId]
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
        Loading review session...
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-red-600">
        {error}
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 px-3 py-6">
      <div className="mx-auto max-w-[1500px] space-y-6">
        <Card>
          <CardContent className="flex flex-col gap-4 py-6 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500">Review Session</div>
              <div className="text-lg font-semibold text-gray-900">{session?.id}</div>
              <div className="text-sm text-gray-500">
                {session?.itemsReviewed ?? 0} reviewed · {session?.itemsAccepted ?? 0} accepted ·{' '}
                {session?.itemsRejected ?? 0} rejected
              </div>
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
                Push to YOLO
              </Button>
            </div>
          </CardContent>
        </Card>

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
        </div>

        <ReviewViewer items={filteredItems} onAction={handleAction} onEdit={handleEdit} />
      </div>

      <YOLOConfigModal
        open={showYoloModal}
        onClose={() => setShowYoloModal(false)}
        availableClasses={availableClasses}
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
    <Suspense fallback={<div className="flex items-center justify-center min-h-screen"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-green-500" /></div>}>
      <ReviewPageContent />
    </Suspense>
  );
}
