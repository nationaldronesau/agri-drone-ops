'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

export default function LegacyImproveReviewRedirect() {
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
            workflowType: 'improve_model',
            targetType: 'both',
            roboflowProjectId: parsed?.roboflowProject?.project?.roboflowId || parsed?.roboflowProjectId,
            confidenceThreshold: parsed?.confidenceThreshold,
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
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="max-w-md text-center space-y-4">
          <p className="text-sm text-red-600">{error}</p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button asChild variant="outline">
              <Link href="/training-hub">Back to Training Hub</Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard">Go to Dashboard</Link>
            </Button>
          </div>
        </div>
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
