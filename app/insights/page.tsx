import { Suspense } from "react";
import TemporalInsightsClient from "@/components/insights/temporal-insights-client";

export default function InsightsPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-gray-500">Loading insights...</div>}>
      <TemporalInsightsClient />
    </Suspense>
  );
}

