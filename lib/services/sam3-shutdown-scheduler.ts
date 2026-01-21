/**
 * SAM3 Auto-Shutdown Scheduler
 *
 * Runs periodic checks to automatically shut down idle AWS SAM3 instances.
 * This helps control costs by stopping instances that haven't been used
 * for the configured idle timeout period (default: 1 hour).
 */
import { awsSam3Service } from './aws-sam3';

const CHECK_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
let shutdownTimer: NodeJS.Timeout | null = null;
let isSchedulerRunning = false;
const AUTO_SHUTDOWN_DISABLED =
  ['1', 'true', 'yes'].includes((process.env.SAM3_DISABLE_AUTO_SHUTDOWN || '').toLowerCase()) ||
  ['1', 'true', 'yes'].includes((process.env.SAM3_SHARED_INSTANCE || '').toLowerCase());

/**
 * Start the auto-shutdown scheduler
 * Should be called when the worker starts
 */
export function startShutdownScheduler(): void {
  if (shutdownTimer || isSchedulerRunning) {
    console.log('[SAM3 Scheduler] Scheduler already running');
    return;
  }

  if (AUTO_SHUTDOWN_DISABLED) {
    console.log('[SAM3 Scheduler] Auto-shutdown disabled by configuration');
    return;
  }

  if (!awsSam3Service.isConfigured()) {
    console.log('[SAM3 Scheduler] AWS SAM3 not configured, scheduler not started');
    return;
  }

  console.log('[SAM3 Scheduler] Starting auto-shutdown scheduler');
  isSchedulerRunning = true;

  shutdownTimer = setInterval(async () => {
    await checkAndShutdownIfIdle();
  }, CHECK_INTERVAL_MS);

  // Don't prevent Node from exiting
  shutdownTimer.unref();
}

/**
 * Stop the auto-shutdown scheduler
 * Should be called when the worker stops
 */
export function stopShutdownScheduler(): void {
  if (shutdownTimer) {
    console.log('[SAM3 Scheduler] Stopping auto-shutdown scheduler');
    clearInterval(shutdownTimer);
    shutdownTimer = null;
    isSchedulerRunning = false;
  }
}

/**
 * Check if the instance is idle and shut it down if so
 * Returns true if shutdown was initiated
 */
export async function checkAndShutdownIfIdle(): Promise<boolean> {
  try {
    if (AUTO_SHUTDOWN_DISABLED) {
      return false;
    }

    if (!awsSam3Service.isConfigured()) {
      return false;
    }

    const status = awsSam3Service.getStatus();

    // Only check if instance is ready (running)
    if (status.instanceState !== 'ready') {
      return false;
    }

    if (awsSam3Service.isIdle()) {
      console.log('[SAM3 Scheduler] Instance idle, initiating shutdown...');
      await awsSam3Service.stopInstance();
      console.log('[SAM3 Scheduler] Shutdown initiated');
      return true;
    }

    return false;
  } catch (error) {
    console.error('[SAM3 Scheduler] Error checking idle status:', error);
    return false;
  }
}

/**
 * Get the scheduler status
 */
export function getSchedulerStatus(): {
  running: boolean;
  checkIntervalMs: number;
} {
  return {
    running: isSchedulerRunning,
    checkIntervalMs: CHECK_INTERVAL_MS,
  };
}
