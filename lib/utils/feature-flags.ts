export function parseFeatureFlags(features: unknown): Record<string, unknown> {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    return {};
  }
  return features as Record<string, unknown>;
}

export function isTemporalInsightsEnabled(features: unknown): boolean {
  if (process.env.ENABLE_TEMPORAL_INSIGHTS === 'true') {
    return true;
  }
  const flags = parseFeatureFlags(features);
  return Boolean(flags.temporalInsights);
}

