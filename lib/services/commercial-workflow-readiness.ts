export type CommercialWorkflowReadinessKey = 'sam' | 'queue' | 'yolo' | 'roboflow';

export interface CommercialWorkflowReadinessInput {
  samConfigured: boolean;
  samReady: boolean;
  samState?: string | null;
  samGpuAvailable?: boolean | null;
  samModelLoaded?: boolean | null;
  samConceptReady?: boolean | null;
  queueReady: boolean;
  yoloReady: boolean;
  yoloError?: string | null;
  roboflowConfigured: boolean;
  roboflowModelCount: number;
}

export interface CommercialWorkflowReadinessCheck {
  key: CommercialWorkflowReadinessKey;
  label: string;
  ready: boolean;
  state: 'ready' | 'blocked' | 'available';
  message: string;
}

export interface CommercialWorkflowReadinessSummary {
  readyForSamDatasetRun: boolean;
  readyForYoloTraining: boolean;
  roboflowFallbackAvailable: boolean;
  checks: CommercialWorkflowReadinessCheck[];
}

export function summarizeCommercialWorkflowReadiness(
  input: CommercialWorkflowReadinessInput
): CommercialWorkflowReadinessSummary {
  const samPrimaryReady = Boolean(input.samReady && input.samModelLoaded);
  const samConceptReady = Boolean(input.samConceptReady);
  const samReady = Boolean(
    input.samConfigured &&
      input.samGpuAvailable &&
      (samPrimaryReady || samConceptReady)
  );
  const roboflowFallbackAvailable = input.roboflowConfigured && input.roboflowModelCount > 0;

  return {
    readyForSamDatasetRun: samReady && input.queueReady,
    readyForYoloTraining: input.yoloReady,
    roboflowFallbackAvailable,
    checks: [
      {
        key: 'sam',
        label: samReady ? 'SAM ready' : 'SAM blocked',
        ready: samReady,
        state: samReady ? 'ready' : 'blocked',
        message: samReady
          ? samConceptReady && !samPrimaryReady
            ? 'SAM3 v2 visual matching is ready via the concept service.'
            : 'SAM3 v2 visual matching is ready for dataset labelling.'
          : `SAM3 is not ready${input.samState ? ` (state: ${input.samState})` : ''}.`,
      },
      {
        key: 'queue',
        label: input.queueReady ? 'Queue ready' : 'Queue blocked',
        ready: input.queueReady,
        state: input.queueReady ? 'ready' : 'blocked',
        message: input.queueReady
          ? 'Redis/BullMQ can accept SAM3 dataset jobs.'
          : 'Redis/BullMQ is unavailable, so dataset labelling cannot be queued.',
      },
      {
        key: 'yolo',
        label: input.yoloReady ? 'YOLO ready' : 'YOLO blocked',
        ready: input.yoloReady,
        state: input.yoloReady ? 'ready' : 'blocked',
        message: input.yoloReady
          ? 'AWS YOLO 11 training service is reachable.'
          : input.yoloError || 'AWS YOLO 11 training service is not reachable.',
      },
      {
        key: 'roboflow',
        label: roboflowFallbackAvailable
          ? 'Roboflow fallback available'
          : 'Roboflow fallback blocked',
        ready: roboflowFallbackAvailable,
        state: roboflowFallbackAvailable ? 'available' : 'blocked',
        message: roboflowFallbackAvailable
          ? `${input.roboflowModelCount} Roboflow model${input.roboflowModelCount === 1 ? '' : 's'} available as explicit fallback/benchmark.`
          : 'Roboflow credentials or enabled models are missing.',
      },
    ],
  };
}
