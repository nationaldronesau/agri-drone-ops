import { describe, expect, it } from 'vitest';
import { summarizeCommercialWorkflowReadiness } from '@/lib/services/commercial-workflow-readiness';

describe('commercial workflow readiness', () => {
  it('marks the full SAM-to-YOLO workflow ready when core services are healthy', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      samConfigured: true,
      samReady: true,
      samState: 'running',
      samGpuAvailable: true,
      samModelLoaded: true,
      queueReady: true,
      yoloReady: true,
      roboflowConfigured: true,
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

  it('blocks SAM dataset runs when the EC2 host is stopped or the model is unloaded', () => {
    const summary = summarizeCommercialWorkflowReadiness({
      samConfigured: true,
      samReady: false,
      samState: 'stopped',
      samGpuAvailable: true,
      samModelLoaded: false,
      queueReady: true,
      yoloReady: true,
      roboflowConfigured: true,
      roboflowModelCount: 1,
    });

    expect(summary.readyForSamDatasetRun).toBe(false);
    expect(summary.checks.find((check) => check.key === 'sam')).toMatchObject({
      label: 'SAM blocked',
      state: 'blocked',
      message: 'SAM3 is not ready (state: stopped).',
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
