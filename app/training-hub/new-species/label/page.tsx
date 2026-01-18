'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

export default function LegacyNewSpeciesLabelRedirect() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      const projectId = typeof window !== 'undefined'
        ? new URLSearchParams(window.location.search).get('project')
        : null;
      const stored = typeof window !== 'undefined' ? sessionStorage.getItem('trainingSession') : null;
      let parsed: any = null;
      try {
        parsed = stored ? JSON.parse(stored) : null;
      } catch {
        parsed = null;
      }

      const resolvedProjectId = projectId || parsed?.localProjectId;
      if (!resolvedProjectId) {
        setError('Missing project information. Start the workflow again.');
        return;
      }

      try {
        const response = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: resolvedProjectId,
          workflowType: 'new_species',
          targetType: 'roboflow',
          roboflowProjectId: parsed?.roboflowProject?.project?.roboflowId || parsed?.roboflowProjectId,
        }),
      });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data.error || 'Failed to create review session');
        }

        const sessionId = data.session?.id;
        if (!sessionId) {
          throw new Error('Review session missing from response');
        }

        const assetsResponse = await fetch(`/api/assets?projectId=${resolvedProjectId}`);
        const assetsData = await assetsResponse.json().catch(() => ({}));
        const assets = assetsData.assets || [];
        const firstAsset =
          assets.find((asset: { annotationCount?: number }) => !asset.annotationCount) || assets[0];

        if (!firstAsset) {
          throw new Error('No assets available to annotate');
        }

        router.replace(`/annotate/${firstAsset.id}?reviewSessionId=${sessionId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start labeling');
      }
    };

    bootstrap();
  }, [router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-red-600">
        {error}
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center text-sm text-gray-500">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      Redirecting to annotate...
    </div>
  );
}
