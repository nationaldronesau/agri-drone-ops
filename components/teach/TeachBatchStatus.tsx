"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock3,
  Cpu,
  Loader2,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import {
  describeTeachBatchStage,
  getTeachBatchProgress,
  type TeachBatchJobStatus,
  type TeachBatchStatusResponse,
} from "@/lib/utils/teach-batch-run";

interface TeachBatchStatusProps {
  status: TeachBatchJobStatus;
  summary?: TeachBatchStatusResponse["summary"];
  execution?: TeachBatchStatusResponse["execution"];
  pollError?: string | null;
  reviewing?: boolean;
  onRetryStatus: () => void;
  onReview: () => void;
  onStartAgain: () => void;
}

export function TeachBatchStatus({
  status,
  summary,
  execution,
  pollError,
  reviewing = false,
  onRetryStatus,
  onReview,
  onStartAgain,
}: TeachBatchStatusProps) {
  const progress = getTeachBatchProgress(status.processedImages, status.totalImages);
  const complete = status.status === "COMPLETED";
  const failed = status.status === "FAILED" || status.status === "CANCELLED";
  const active = !complete && !failed;
  const title = describeTeachBatchStage(status);

  return (
    <section
      aria-live="polite"
      className={`mx-5 mt-3 rounded-xl border px-4 py-4 shadow-sm lg:mx-7 ${
        failed
          ? "border-red-200 bg-red-50"
          : complete
            ? "border-emerald-200 bg-emerald-50"
            : "border-blue-200 bg-blue-50"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <span className={`mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-lg ${failed ? "bg-red-100 text-red-700" : complete ? "bg-emerald-100 text-emerald-700" : "bg-blue-100 text-blue-700"}`}>
            {failed ? <AlertTriangle className="h-5 w-5" /> : complete ? <CheckCircle2 className="h-5 w-5" /> : status.status === "QUEUED" ? <Clock3 className="h-5 w-5" /> : <Loader2 className="h-5 w-5 animate-spin" />}
          </span>
          <div className="min-w-0">
            <h2 className="font-semibold text-gray-950">{title}</h2>
            <p className="mt-1 text-sm text-gray-600">
              {status.processedImages} of {status.totalImages} images processed
              {status.detectionsFound > 0 ? ` · ${status.detectionsFound} suggestions found` : ""}
            </p>
          </div>
        </div>
        <span className="rounded-full border border-current/15 bg-white/70 px-2.5 py-1 text-xs font-semibold text-gray-700">
          {status.status.toLowerCase().replaceAll("_", " ")}
        </span>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/80" aria-label={`${progress}% complete`}>
        <div className={`h-full rounded-full transition-all ${failed ? "bg-red-500" : complete ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${progress}%` }} />
      </div>

      {summary && complete ? (
        <p className="mt-3 text-sm text-gray-700">
          {summary.pending} pending review · {summary.accepted} accepted · {summary.rejected} rejected
        </p>
      ) : null}

      {status.errorMessage ? (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-sm ${failed ? "border-red-200 bg-white text-red-800" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          {status.errorMessage}
        </div>
      ) : null}

      {pollError ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span>{pollError}</span>
          <button type="button" onClick={onRetryStatus} className="inline-flex items-center gap-1.5 font-semibold text-amber-950">
            <RotateCcw className="h-3.5 w-3.5" /> Check again
          </button>
        </div>
      ) : null}

      <details className="mt-3 rounded-lg border border-gray-200/80 bg-white/70 px-3 py-2.5 text-sm text-gray-700">
        <summary className="cursor-pointer font-medium text-gray-900">Technical details</summary>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <p className="flex items-start gap-2"><Cpu className="mt-0.5 h-4 w-4 flex-none text-gray-500" /><span><strong>Model route:</strong> {execution?.pipelineLabel || "Direct SAM3 batch service"}</span></p>
          <p className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-gray-500" /><span><strong>External fallback:</strong> {execution?.externalProviderFallback === false ? "None — no YOLO or Roboflow provider fallback" : "Awaiting runtime evidence"}</span></p>
          <p><strong>Runtime evidence:</strong> {execution?.runtimeConfirmed ? "Recorded by the worker" : "Waiting for the worker"}</p>
          <p><strong>Review profile:</strong> {execution?.reviewProfile?.replaceAll("_", " ") || "Waiting for the worker"}</p>
        </div>
        {execution && (execution.candidateExpansionAssets > 0 || execution.refinementFallbackAssets > 0) ? (
          <p className="mt-3 rounded-md bg-amber-50 px-2.5 py-2 text-amber-900">
            Same-model recovery used on {execution.degradedAssets} image{execution.degradedAssets === 1 ? "" : "s"}: {execution.candidateExpansionAssets} lower-threshold candidate expansion · {execution.refinementFallbackAssets} unrefined candidate fallback. Review these suggestions carefully.
          </p>
        ) : null}
      </details>

      <div className="mt-4 flex flex-wrap gap-2">
        {complete ? (
          <button type="button" onClick={onReview} disabled={reviewing} className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-60">
            {reviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
            {reviewing ? "Opening review…" : "Review these suggestions"}
            {!reviewing && <ArrowRight className="h-4 w-4" />}
          </button>
        ) : null}
        {complete ? (
          <button type="button" onClick={onStartAgain} disabled={reviewing} className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50 disabled:opacity-60">
            <RotateCcw className="h-4 w-4" /> Start a new search
          </button>
        ) : null}
        {failed ? (
          <button type="button" onClick={onStartAgain} className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50">
            <RotateCcw className="h-4 w-4" /> Start this search again
          </button>
        ) : null}
        {active && pollError ? (
          <button type="button" onClick={onStartAgain} className="inline-flex h-10 items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-semibold text-gray-800 hover:bg-gray-50">
            Discard saved search
          </button>
        ) : null}
        {active ? <p className="self-center text-xs text-gray-600">You can leave this page. Progress will be restored when you return.</p> : null}
      </div>
    </section>
  );
}
