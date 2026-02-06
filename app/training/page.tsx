import { Suspense } from 'react';
import TrainingClient from '@/components/training/training-client';

export default function TrainingPage() {
  return (
    <Suspense fallback={<div className="p-6">Loading training…</div>}>
      <TrainingClient />
    </Suspense>
  );
}
