import { describe, expect, it } from 'vitest';
import { summarizeCommercialWorkflowReadiness } from '@/lib/services/commercial-workflow-readiness';

const baseInput = {
  samConfigured: true,
  samReady: true,
  samState: 'ready',
  samGpuAvailable: true,
  samModelLoaded: true,
  samConceptReady: false,
  queueReady: true,
  yoloReady: true,
  yoloError: null,
  roboflowConfigured: true,
  roboflowModelCount: 1,
};

describe('commercial workflow readiness', () => {
  it('marks the full SAM-to-YOLO workflow ready when core services are healthy', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      ...baseInput,
      samState: 'running',
      roboflowModelCount: 2,
    });

    expect(summary.readyForSamDatasetRun).toBe(true);
    expect(summary.readyForYoloTraining).toBe(true);
    expect(summary.roboflowFallbackAvailable).toBe(true);
    expect(summary.checks.map((check) => check.label)).toEqual([
      'SAM ready',
      'Queue ready',
      'YOLO ready',
      'Roboflow fallback available',
    ]);
  });

  it('treats primary SAM readiness as dataset-run ready', () => {
    const summary = summarizeCommercialWorkflowReadiness(baseInput);

    expect(summary.readyForSamDatasetRun).toBe(true);
    expect(summary.checks.find((check) => check.key === 'sam')).toMatchObject({
      label: 'SAM ready',
      ready: true,
    });
  });

  it('blocks SAM dataset runs when the EC2 host is stopped and no SAM concept service is ready', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      ...baseInput,
      samReady: false,
      samState: 'stopped',
      samModelLoaded: false,
      samConceptReady: false,
    });

    expect(summary.readyForSamDatasetRun).toBe(false);
    expect(summary.checks.find((check) => check.key === 'sam')).toMatchObject({
      label: 'SAM blocked',
      state: 'blocked',
      message: 'SAM3 is not ready (state: stopped).',
    });
  });

  it('treats concept-ready SAM as dataset-run ready while the primary model is unloaded', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      ...baseInput,
      samReady: false,
      samState: 'running',
      samModelLoaded: false,
      samConceptReady: true,
    });

    expect(summary.readyForSamDatasetRun).toBe(true);
    expect(summary.checks.find((check) => check.key === 'sam')).toMatchObject({
      label: 'SAM ready',
      ready: true,
      message: 'SAM3 v2 visual matching is ready via the concept service.',
    });
  });

  it('keeps Roboflow as an explicit fallback without marking SAM ready', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      samConfigured: false,
      samReady: false,
      queueReady: false,
      yoloReady: false,
      yoloError: 'YOLO service unavailable',
      roboflowConfigured: true,
      roboflowModelCount: 3,
    });

    expect(summary.readyForSamDatasetRun).toBe(false);
    expect(summary.readyForYoloTraining).toBe(false);
    expect(summary.roboflowFallbackAvailable).toBe(true);
    expect(summary.checks.find((check) => check.key === 'roboflow')).toMatchObject({
      label: 'Roboflow fallback available',
      state: 'available',
    });
  });
});
