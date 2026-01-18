'use client';

import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';

interface BatchProgressProps {
  processed: number;
  total: number;
  status: string;
  onReview?: () => void;
}

export function BatchProgress({ processed, total, status, onReview }: BatchProgressProps) {
  const progress = total > 0 ? Math.round((processed / total) * 100) : 0;
  const isComplete = status === 'COMPLETED';

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-sm font-medium text-gray-700">Batch Progress</div>
      <div className="mt-2 text-xs text-gray-500">
        {processed}/{total} images processed · {status.toLowerCase()}
      </div>
      <Progress value={progress} className="mt-2" />
      {isComplete && onReview && (
        <Button className="mt-3" onClick={onReview}>
          Review predictions
        </Button>
      )}
    </div>
  );
}
