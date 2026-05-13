'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Power, PowerOff, RefreshCw, Server } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface Sam3StatusResponse {
  aws: {
    configured: boolean;
    state: string;
    ready: boolean;
    gpuAvailable?: boolean;
    modelLoaded?: boolean;
  };
  funMessage?: string;
}

interface Sam3StartResponse {
  success: boolean;
  ready: boolean;
  starting: boolean;
  message?: string;
}

type HealthState = {
  loading: boolean;
  available: boolean;
};

const STARTUP_MESSAGE = 'Waiting for the EC2 instance and SAM3 model to become ready.';

export function Sam3Ec2Control() {
  const [health, setHealth] = useState<HealthState>({ loading: true, available: false });
  const [status, setStatus] = useState<Sam3StatusResponse | null>(null);
  const [sam3WarmupMessage, setSam3WarmupMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startRequestedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    setError(null);
    setHealth((current) => ({ ...current, loading: true }));

    try {
      const response = await fetch('/api/sam3/status', { cache: 'no-store' });
      const data: Sam3StatusResponse = await response.json();

      if (!response.ok) {
        throw new Error('Failed to check SAM3 status');
      }

      setStatus(data);
      setHealth({ loading: false, available: Boolean(data.aws?.ready) });

      if (data.aws?.ready) {
        setSam3WarmupMessage(null);
        startRequestedRef.current = false;
      } else if (data.aws?.state === 'starting' || data.aws?.state === 'warming') {
        setSam3WarmupMessage(STARTUP_MESSAGE);
      }

      return data;
    } catch (err) {
      setHealth({ loading: false, available: false });
      setError(err instanceof Error ? err.message : 'Failed to check SAM3 status');
      return null;
    }
  }, []);

  const startSam3 = useCallback(async (manual = false) => {
    if (!manual && startRequestedRef.current) return;

    startRequestedRef.current = true;
    setActionLoading('start');
    setError(null);
    setSam3WarmupMessage(STARTUP_MESSAGE);

    try {
      const response = await fetch('/api/sam3/start', { method: 'POST' });
      const data: Sam3StartResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to start SAM3 GPU instance');
      }

      if (data.ready) {
        setSam3WarmupMessage(null);
      }
    } catch (err) {
      startRequestedRef.current = false;
      setSam3WarmupMessage(null);
      setError(err instanceof Error ? err.message : 'Failed to start SAM3 GPU instance');
    } finally {
      setActionLoading(null);
      void fetchStatus();
    }
  }, [fetchStatus]);

  const stopSam3 = async () => {
    setActionLoading('stop');
    setError(null);

    try {
      const response = await fetch('/api/sam3/stop', { method: 'POST' });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to stop SAM3 GPU instance');
      }

      startRequestedRef.current = false;
      setSam3WarmupMessage(null);
      await fetchStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop SAM3 GPU instance');
    } finally {
      setActionLoading(null);
    }
  };

  useEffect(() => {
    let cancelled = false;

    const initialise = async () => {
      const currentStatus = await fetchStatus();

      if (
        !cancelled &&
        currentStatus?.aws?.configured &&
        !currentStatus.aws.ready &&
        currentStatus.aws.state !== 'stopping'
      ) {
        await startSam3();
      }
    };

    void initialise();

    const pollTimer = setInterval(fetchStatus, 5000);

    return () => {
      cancelled = true;
      clearInterval(pollTimer);
    };
  }, [fetchStatus, startSam3]);

  const awsConfigured = Boolean(status?.aws?.configured);
  const stateLabel = status?.aws?.state ? `EC2: ${status.aws.state}` : 'EC2 status pending';

  return (
    <div className="mb-8">
      {sam3WarmupMessage && (
        <Card className="border-blue-200 bg-blue-50 mb-4">
          <CardContent className="py-4">
            <div className="flex items-center gap-3 text-blue-700">
              <RefreshCw className="w-5 h-5 animate-spin" />
              <div>
                <p className="font-medium">Starting SAM3 GPU...</p>
                <p className="text-sm text-blue-600">{sam3WarmupMessage}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-gray-200">
        <CardContent className="flex flex-col gap-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-700">
              <Server className="h-5 w-5" />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium text-gray-900">SAM3 GPU Service</p>
                {health.loading ? (
                  <Badge variant="secondary">Checking...</Badge>
                ) : health.available ? (
                  <Badge className="bg-emerald-100 text-emerald-700">Service Online</Badge>
                ) : (
                  <Badge className="bg-red-100 text-red-700">Service Offline</Badge>
                )}
              </div>
              <p className="text-sm text-gray-600">
                {awsConfigured ? stateLabel : 'AWS SAM3 is not configured'}
                {error ? <span className="text-red-600"> - {error}</span> : null}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fetchStatus()}
              disabled={health.loading || actionLoading !== null}
            >
              <RefreshCw className={`mr-2 h-4 w-4 ${health.loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => startSam3(true)}
              disabled={!awsConfigured || health.available || actionLoading !== null}
            >
              <Power className="mr-2 h-4 w-4" />
              {actionLoading === 'start' ? 'Starting...' : 'Start GPU'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={stopSam3}
              disabled={!awsConfigured || !status?.aws || actionLoading !== null || status.aws.state === 'stopped'}
            >
              <PowerOff className="mr-2 h-4 w-4" />
              {actionLoading === 'stop' ? 'Stopping...' : 'Stop GPU'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
