import { Suspense } from 'react';
import { TrainingWorkspace } from '@/components/training/training-workspace';

export default function TrainingPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading training…</div>}>
      <TrainingWorkspace />
    </Suspense>
  );
}
