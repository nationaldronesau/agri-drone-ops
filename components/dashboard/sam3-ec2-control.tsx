'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Power, PowerOff, RefreshCw, Server } from 'lucide-react';

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

interface Sam3Ec2ControlProps {
  autoStartOnLoad?: boolean;
  showDetails?: boolean;
  title?: string;
  onReadyChange?: (ready: boolean) => void;
}

const STARTUP_MESSAGE = 'Waiting for the EC2 instance and SAM3 model to become ready.';

export function Sam3Ec2Control({
  autoStartOnLoad = false,
  showDetails = false,
  title = 'SAM3 GPU Service',
  onReadyChange,
}: Sam3Ec2ControlProps) {
  const [health, setHealth] = useState<HealthState>({ loading: true, available: false });
  const [status, setStatus] = useState<Sam3StatusResponse | null>(null);
  const [sam3WarmupMessage, setSam3WarmupMessage] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<'start' | 'stop' | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const startRequestedRef = useRef(false);

  const fetchStatus = useCallback(async () => {
    setHealth((current) => ({ ...current, loading: true }));

    try {
      const response = await fetch('/api/sam3/status', { cache: 'no-store' });
      const data: Sam3StatusResponse = await response.json();

      if (!response.ok) {
        throw new Error('Failed to check SAM3 status');
      }

      setStatusError(null);
      setStatus(data);
      const safeToProcess = Boolean(
        data.aws?.ready &&
        data.aws.modelLoaded !== false &&
        data.aws.gpuAvailable !== false
      );
      setHealth({ loading: false, available: safeToProcess });
      onReadyChange?.(safeToProcess);

      if (data.aws?.ready) {
        setSam3WarmupMessage(null);
        startRequestedRef.current = false;
      } else if (data.aws?.state === 'starting' || data.aws?.state === 'warming') {
        setSam3WarmupMessage(STARTUP_MESSAGE);
      }

      return data;
    } catch (err) {
      setHealth({ loading: false, available: false });
      onReadyChange?.(false);
      setStatusError(err instanceof Error ? err.message : 'Failed to check SAM3 status');
      return null;
    }
  }, [onReadyChange]);

  const startSam3 = useCallback(async (manual = false) => {
    if (!manual && startRequestedRef.current) return;

    startRequestedRef.current = true;
    setActionLoading('start');
    setActionError(null);
    setSam3WarmupMessage(STARTUP_MESSAGE);
    let accepted = false;

    try {
      const response = await fetch('/api/sam3/start', { method: 'POST' });
      const data: Sam3StartResponse = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to start SAM3 GPU instance');
      }

      if (data.ready) {
        setSam3WarmupMessage(null);
      }
      setActionError(null);
      accepted = true;
    } catch (err) {
      startRequestedRef.current = false;
      setSam3WarmupMessage(null);
      setActionError(err instanceof Error ? err.message : 'Failed to start SAM3 GPU instance');
    } finally {
      setActionLoading(null);
      if (accepted) {
        void fetchStatus();
      }
    }
  }, [fetchStatus]);

  const stopSam3 = async () => {
    setActionLoading('stop');
    setActionError(null);
    let stopped = false;

    try {
      const response = await fetch('/api/sam3/stop', { method: 'POST' });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to stop SAM3 GPU instance');
      }

      startRequestedRef.current = false;
      setSam3WarmupMessage(null);
      setActionError(null);
      stopped = true;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to stop SAM3 GPU instance');
    } finally {
      setActionLoading(null);
      if (stopped) {
        await fetchStatus();
      }
    }
  };

  useEffect(() => {
    let cancelled = false;

    const initialise = async () => {
      const currentStatus = await fetchStatus();

      if (
        autoStartOnLoad &&
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
  }, [autoStartOnLoad, fetchStatus, startSam3]);

  const awsConfigured = Boolean(status?.aws?.configured);
  const stateLabel = status?.aws?.state ? `EC2: ${status.aws.state}` : 'EC2 status pending';
  const modelLoaded = status?.aws?.modelLoaded === true;
  const gpuAvailable = status?.aws?.gpuAvailable === true;
  const visibleError = actionError || statusError;

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
        <CardContent className="flex flex-col gap-4 py-4">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-green-100 text-green-700">
                <Server className="h-5 w-5" />
              </div>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium text-gray-900">{title}</p>
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
                {actionLoading === 'start' ? 'Waking...' : 'Wake SAM3'}
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
          </div>

          {showDetails && (
            <div className="grid w-full gap-3 border-t pt-4 text-sm sm:grid-cols-4">
              <div>
                <p className="text-gray-500">EC2 State</p>
                <p className="font-medium text-gray-900">{status?.aws?.state || 'unknown'}</p>
              </div>
              <div>
                <p className="text-gray-500">GPU Available</p>
                <p className={gpuAvailable ? 'font-medium text-emerald-700' : 'font-medium text-gray-900'}>
                  {gpuAvailable ? 'Yes' : 'No'}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Model Loaded</p>
                <p className={modelLoaded ? 'font-medium text-emerald-700' : 'font-medium text-gray-900'}>
                  {modelLoaded ? 'Yes' : 'No'}
                </p>
              </div>
              <div>
                <p className="text-gray-500">Processing</p>
                <p className={`flex items-center gap-1 font-medium ${health.available ? 'text-emerald-700' : 'text-amber-700'}`}>
                  {health.available ? (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      Safe to process
                    </>
                  ) : (
                    <>
                      <AlertCircle className="h-4 w-4" />
                      Not ready
                    </>
                  )}
                </p>
              </div>
              {visibleError && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-red-700 sm:col-span-4">
                  {visibleError}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
