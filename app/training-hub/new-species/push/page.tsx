'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';

type StoredTrainingSession = {
  localProjectId?: string;
  roboflowProject?: { project?: { roboflowId?: string } };
  roboflowProjectId?: string;
};

export default function LegacyNewSpeciesPushRedirect() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const bootstrap = async () => {
      const stored = typeof window !== 'undefined' ? sessionStorage.getItem('trainingSession') : null;
      let parsed: StoredTrainingSession | null = null;
      try {
        parsed = stored ? (JSON.parse(stored) as StoredTrainingSession) : null;
      } catch {
        parsed = null;
      }

      const projectId = parsed?.localProjectId;
      if (!projectId) {
        setError('Missing project information. Start the workflow again.');
        return;
      }

      try {
        const response = await fetch('/api/review', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
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

        router.replace(`/review?sessionId=${sessionId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start unified review');
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
      Redirecting to unified review...
    </div>
  );
}
