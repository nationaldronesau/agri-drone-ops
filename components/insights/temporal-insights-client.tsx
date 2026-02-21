"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { AlertTriangle, Loader2, PlayCircle, Route, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { parseFeatureFlags } from "@/lib/utils/feature-flags";

const TemporalInsightsMap = dynamic(
  () => import("@/components/insights/temporal-insights-map"),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-[420px] items-center justify-center rounded-lg border border-gray-200 bg-white text-sm text-gray-500">
        Loading map...
      </div>
    ),
  }
);

interface Project {
  id: string;
  name: string;
  location: string | null;
  features?: unknown;
}

interface Survey {
  id: string;
  name: string;
  surveyKey: string;
  startedAt: string;
  endedAt: string;
  assetCount: number;
}

interface TemporalRunListItem {
  id: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
}

interface TemporalRunDetail {
  id: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  summary: {
    counts?: {
      new?: number;
      persistent?: number;
      resolved?: number;
      unobserved?: number;
    };
    risk?: {
      high?: number;
      medium?: number;
      low?: number;
    };
    speciesBreakdown?: Array<{
      species: string;
      new: number;
      persistent: number;
      resolved: number;
      unobserved: number;
    }>;
  } | null;
  baselineSurvey: {
    id: string;
    name: string;
  };
  comparisonSurvey: {
    id: string;
    name: string;
  };
}

interface ChangeItem {
  id: string;
  changeType: "NEW" | "PERSISTENT" | "RESOLVED" | "UNOBSERVED";
  species: string;
  riskScore: number;
  confidence: number | null;
  comparisonLat: number | null;
  comparisonLon: number | null;
  baselineLat: number | null;
  baselineLon: number | null;
}

interface HotspotItem {
  id: string;
  species: string;
  priorityScore: number | null;
  avgRiskScore: number | null;
  itemCount: number;
  centroidLat: number;
  centroidLon: number;
  polygon: unknown;
}

const TERMINAL_STATUSES = new Set(["READY", "FAILED", "CANCELLED"]);

function formatStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "READY") return "default";
  if (status === "FAILED" || status === "CANCELLED") return "destructive";
  if (status === "PROCESSING" || status === "QUEUED") return "secondary";
  return "outline";
}

function parseSpeciesList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export default function TemporalInsightsClient() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>("");
  const [surveys, setSurveys] = useState<Survey[]>([]);
  const [baselineSurveyId, setBaselineSurveyId] = useState<string>("");
  const [comparisonSurveyId, setComparisonSurveyId] = useState<string>("");
  const [runs, setRuns] = useState<TemporalRunListItem[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>("");
  const [runDetail, setRunDetail] = useState<TemporalRunDetail | null>(null);
  const [changes, setChanges] = useState<ChangeItem[]>([]);
  const [hotspots, setHotspots] = useState<HotspotItem[]>([]);
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingSurveys, setLoadingSurveys] = useState(false);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [loadingRunDetail, setLoadingRunDetail] = useState(false);
  const [creatingRun, setCreatingRun] = useState(false);
  const [creatingDeltaPlan, setCreatingDeltaPlan] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [speciesFilterInput, setSpeciesFilterInput] = useState("");
  const [minConfidence, setMinConfidence] = useState(0.45);
  const [changeSpeciesFilter, setChangeSpeciesFilter] = useState("all");
  const [minRiskFilter, setMinRiskFilter] = useState(0);
  const [deltaRiskThreshold, setDeltaRiskThreshold] = useState(0.55);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const response = await fetch("/api/projects?pageSize=200");
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load projects");
      }
      const allProjects: Project[] = Array.isArray(data.projects) ? data.projects : [];
      const temporalProjects = allProjects.filter((project) => {
        const flags = parseFeatureFlags(project.features);
        return Boolean(flags.temporalInsights) || process.env.NEXT_PUBLIC_ENABLE_TEMPORAL_INSIGHTS === "true";
      });
      setProjects(temporalProjects);
      if (!selectedProjectId && temporalProjects.length > 0) {
        setSelectedProjectId(temporalProjects[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoadingProjects(false);
    }
  }, [selectedProjectId]);

  const loadSurveys = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoadingSurveys(true);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/surveys`);
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load surveys");
      }
      const nextSurveys: Survey[] = data.surveys || [];
      setSurveys(nextSurveys);

      const baselineId =
        data.defaults?.baselineSurveyId || nextSurveys[1]?.id || nextSurveys[0]?.id || "";
      const comparisonId =
        data.defaults?.comparisonSurveyId || nextSurveys[0]?.id || "";
      setBaselineSurveyId(baselineId);
      setComparisonSurveyId(comparisonId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load surveys");
      setSurveys([]);
    } finally {
      setLoadingSurveys(false);
    }
  }, [selectedProjectId]);

  const loadRuns = useCallback(async () => {
    if (!selectedProjectId) return;
    setLoadingRuns(true);
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/temporal-runs?limit=20&offset=0`
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load temporal runs");
      }
      const nextRuns: TemporalRunListItem[] = data.runs || [];
      setRuns(nextRuns);
      if (!selectedRunId && nextRuns.length > 0) {
        setSelectedRunId(nextRuns[0].id);
      } else if (selectedRunId && !nextRuns.some((run) => run.id === selectedRunId)) {
        setSelectedRunId(nextRuns[0]?.id || "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load temporal runs");
      setRuns([]);
    } finally {
      setLoadingRuns(false);
    }
  }, [selectedProjectId, selectedRunId]);

  const loadRunDetail = useCallback(async () => {
    if (!selectedProjectId || !selectedRunId) {
      setRunDetail(null);
      return;
    }
    setLoadingRunDetail(true);
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/temporal-runs/${selectedRunId}`
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to load run detail");
      }
      setRunDetail(data as TemporalRunDetail);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load run detail");
      setRunDetail(null);
    } finally {
      setLoadingRunDetail(false);
    }
  }, [selectedProjectId, selectedRunId]);

  const loadRunData = useCallback(async () => {
    if (!selectedProjectId || !selectedRunId) {
      setChanges([]);
      setHotspots([]);
      return;
    }

    try {
      const speciesParam = changeSpeciesFilter !== "all" ? `&species=${encodeURIComponent(changeSpeciesFilter)}` : "";
      const [changesRes, hotspotsRes] = await Promise.all([
        fetch(
          `/api/projects/${selectedProjectId}/temporal-runs/${selectedRunId}/changes?page=1&limit=500&minRisk=${minRiskFilter}${speciesParam}`
        ),
        fetch(
          `/api/projects/${selectedProjectId}/temporal-runs/${selectedRunId}/hotspots?limit=200&minPriority=${minRiskFilter}${speciesParam}`
        ),
      ]);

      const changesData = await changesRes.json();
      const hotspotsData = await hotspotsRes.json();

      if (!changesRes.ok) {
        throw new Error(changesData?.error || "Failed to load changes");
      }
      if (!hotspotsRes.ok) {
        throw new Error(hotspotsData?.error || "Failed to load hotspots");
      }

      setChanges(changesData.items || []);
      setHotspots(hotspotsData.hotspots || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load temporal results");
      setChanges([]);
      setHotspots([]);
    }
  }, [selectedProjectId, selectedRunId, changeSpeciesFilter, minRiskFilter]);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  useEffect(() => {
    if (!selectedProjectId) return;
    setSelectedRunId("");
    setRunDetail(null);
    setChanges([]);
    setHotspots([]);
    void loadSurveys();
    void loadRuns();
  }, [selectedProjectId, loadRuns, loadSurveys]);

  useEffect(() => {
    void loadRunDetail();
  }, [loadRunDetail]);

  useEffect(() => {
    if (!runDetail || TERMINAL_STATUSES.has(runDetail.status)) return;
    const timer = setInterval(() => {
      void loadRunDetail();
      void loadRuns();
    }, 3000);
    return () => clearInterval(timer);
  }, [runDetail, loadRunDetail, loadRuns]);

  useEffect(() => {
    if (!runDetail || runDetail.status !== "READY") {
      setChanges([]);
      setHotspots([]);
      return;
    }
    void loadRunData();
  }, [runDetail, loadRunData]);

  const uniqueSpecies = useMemo(() => {
    const species = new Set<string>();
    changes.forEach((item) => species.add(item.species));
    hotspots.forEach((item) => species.add(item.species));
    return Array.from(species).sort((a, b) => a.localeCompare(b));
  }, [changes, hotspots]);

  const summary = runDetail?.summary;
  const counts = summary?.counts || {};
  const riskSummary = summary?.risk || {};
  const speciesBreakdown = summary?.speciesBreakdown || [];

  const handleCreateRun = async () => {
    if (!selectedProjectId || !baselineSurveyId || !comparisonSurveyId) return;
    setCreatingRun(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/projects/${selectedProjectId}/temporal-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baselineSurveyId,
          comparisonSurveyId,
          species: parseSpeciesList(speciesFilterInput),
          minConfidence,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create temporal run");
      }
      setSelectedRunId(data.runId);
      setNotice("Temporal run created and queued.");
      await loadRuns();
      await loadRunDetail();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create temporal run");
    } finally {
      setCreatingRun(false);
    }
  };

  const handleGenerateDeltaPlan = async () => {
    if (!selectedProjectId || !selectedRunId) return;
    setCreatingDeltaPlan(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/projects/${selectedProjectId}/temporal-runs/${selectedRunId}/delta-spray-plan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            includedChangeTypes: ["NEW", "PERSISTENT"],
            riskThreshold: deltaRiskThreshold,
          }),
        }
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || "Failed to create delta spray plan");
      }
      setNotice(`Delta spray plan queued (${data.planId}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create delta spray plan");
    } finally {
      setCreatingDeltaPlan(false);
    }
  };

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Temporal Insights</h1>
          <p className="text-sm text-gray-500">
            Compare surveys, classify change, and generate delta spray plans.
          </p>
        </div>
        {runDetail && (
          <Badge variant={statusVariant(runDetail.status)}>{formatStatus(runDetail.status)}</Badge>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            Run Comparison
          </CardTitle>
          <CardDescription>
            Select project and survey pair. Default is latest vs previous survey.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label>Project</Label>
            <Select
              value={selectedProjectId}
              onValueChange={setSelectedProjectId}
              disabled={loadingProjects}
            >
              <SelectTrigger>
                <SelectValue placeholder={loadingProjects ? "Loading projects..." : "Select project"} />
              </SelectTrigger>
              <SelectContent>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Baseline Survey</Label>
            <Select
              value={baselineSurveyId}
              onValueChange={setBaselineSurveyId}
              disabled={loadingSurveys || surveys.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select baseline survey" />
              </SelectTrigger>
              <SelectContent>
                {surveys.map((survey) => (
                  <SelectItem key={survey.id} value={survey.id}>
                    {survey.name} ({new Date(survey.startedAt).toLocaleDateString()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Comparison Survey</Label>
            <Select
              value={comparisonSurveyId}
              onValueChange={setComparisonSurveyId}
              disabled={loadingSurveys || surveys.length === 0}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select comparison survey" />
              </SelectTrigger>
              <SelectContent>
                {surveys.map((survey) => (
                  <SelectItem key={survey.id} value={survey.id}>
                    {survey.name} ({new Date(survey.startedAt).toLocaleDateString()})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>Species Filter (optional)</Label>
            <Input
              placeholder="wattle, lantana"
              value={speciesFilterInput}
              onChange={(event) => setSpeciesFilterInput(event.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Min Confidence</Label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minConfidence}
              onChange={(event) => setMinConfidence(Number(event.target.value))}
            />
          </div>

          <div className="flex items-end">
            <Button
              className="w-full"
              onClick={handleCreateRun}
              disabled={
                creatingRun ||
                !selectedProjectId ||
                !baselineSurveyId ||
                !comparisonSurveyId ||
                baselineSurveyId === comparisonSurveyId
              }
            >
              {creatingRun ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Creating...
                </>
              ) : (
                <>
                  <PlayCircle className="mr-2 h-4 w-4" />
                  Create Temporal Run
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-12">
        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle>Recent Runs</CardTitle>
            <CardDescription>Latest comparisons for this project.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {loadingRuns ? (
              <p className="text-sm text-gray-500">Loading runs...</p>
            ) : runs.length === 0 ? (
              <p className="text-sm text-gray-500">No runs yet.</p>
            ) : (
              runs.map((run) => (
                <button
                  key={run.id}
                  className={`w-full rounded-md border px-3 py-2 text-left transition ${
                    selectedRunId === run.id
                      ? "border-blue-300 bg-blue-50"
                      : "border-gray-200 bg-white hover:bg-gray-50"
                  }`}
                  onClick={() => setSelectedRunId(run.id)}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-gray-800">
                      {run.id.slice(0, 8)}
                    </span>
                    <Badge variant={statusVariant(run.status)}>{formatStatus(run.status)}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-gray-500">
                    {new Date(run.createdAt).toLocaleString()}
                  </p>
                  {!TERMINAL_STATUSES.has(run.status) && (
                    <p className="mt-1 text-xs text-gray-500">Progress: {run.progress}%</p>
                  )}
                </button>
              ))
            )}
          </CardContent>
        </Card>

        <div className="space-y-6 lg:col-span-9">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>New</CardDescription>
                <CardTitle className="text-2xl">{counts.new ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Persistent</CardDescription>
                <CardTitle className="text-2xl">{counts.persistent ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Resolved</CardDescription>
                <CardTitle className="text-2xl">{counts.resolved ?? 0}</CardTitle>
              </CardHeader>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription>Unobserved</CardDescription>
                <CardTitle className="text-2xl">{counts.unobserved ?? 0}</CardTitle>
              </CardHeader>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Map Overlay</CardTitle>
              <CardDescription>Hotspots and per-item temporal changes.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="space-y-2">
                  <Label>Species Filter</Label>
                  <Select
                    value={changeSpeciesFilter}
                    onValueChange={setChangeSpeciesFilter}
                    disabled={!runDetail || runDetail.status !== "READY"}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All species</SelectItem>
                      {uniqueSpecies.map((species) => (
                        <SelectItem key={species} value={species}>
                          {species}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Min Risk</Label>
                  <Input
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={minRiskFilter}
                    onChange={(event) => setMinRiskFilter(Number(event.target.value))}
                    disabled={!runDetail || runDetail.status !== "READY"}
                  />
                </div>
                <div className="flex items-end">
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => void loadRunData()}
                    disabled={!runDetail || runDetail.status !== "READY"}
                  >
                    Apply Filters
                  </Button>
                </div>
              </div>

              <TemporalInsightsMap changes={changes} hotspots={hotspots} />
            </CardContent>
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Species Trend</CardTitle>
                <CardDescription>
                  New + persistent counts by species.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {speciesBreakdown.length === 0 ? (
                  <p className="text-sm text-gray-500">No summary data available yet.</p>
                ) : (
                  speciesBreakdown.slice(0, 12).map((row) => {
                    const activeCount = (row.new || 0) + (row.persistent || 0);
                    const maxCount = Math.max(
                      1,
                      ...speciesBreakdown.map((item) => (item.new || 0) + (item.persistent || 0))
                    );
                    const widthPct = Math.round((activeCount / maxCount) * 100);
                    return (
                      <div key={row.species}>
                        <div className="mb-1 flex items-center justify-between text-xs">
                          <span className="font-medium text-gray-700">{row.species}</span>
                          <span className="text-gray-500">
                            {activeCount} active · {row.resolved || 0} resolved
                          </span>
                        </div>
                        <div className="h-2 rounded bg-gray-100">
                          <div
                            className="h-2 rounded bg-blue-500"
                            style={{ width: `${widthPct}%` }}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Risk Buckets</CardTitle>
                <CardDescription>Distribution of calculated risk scores.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center justify-between rounded border border-gray-200 px-3 py-2">
                  <span className="text-sm text-gray-600">High (≥ 0.80)</span>
                  <span className="font-semibold">{riskSummary.high ?? 0}</span>
                </div>
                <div className="flex items-center justify-between rounded border border-gray-200 px-3 py-2">
                  <span className="text-sm text-gray-600">Medium (0.55-0.79)</span>
                  <span className="font-semibold">{riskSummary.medium ?? 0}</span>
                </div>
                <div className="flex items-center justify-between rounded border border-gray-200 px-3 py-2">
                  <span className="text-sm text-gray-600">Low (0.01-0.54)</span>
                  <span className="font-semibold">{riskSummary.low ?? 0}</span>
                </div>

                <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                  <Label>Delta Plan Risk Threshold</Label>
                  <Input
                    className="mt-2"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={deltaRiskThreshold}
                    onChange={(event) => setDeltaRiskThreshold(Number(event.target.value))}
                    disabled={!runDetail || runDetail.status !== "READY"}
                  />
                  <Button
                    className="mt-3 w-full"
                    onClick={handleGenerateDeltaPlan}
                    disabled={!runDetail || runDetail.status !== "READY" || creatingDeltaPlan}
                  >
                    {creatingDeltaPlan ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        Queueing...
                      </>
                    ) : (
                      <>
                        <Route className="mr-2 h-4 w-4" />
                        Generate Delta Spray Plan
                      </>
                    )}
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Top Hotspots</CardTitle>
              <CardDescription>Highest-priority clusters for intervention.</CardDescription>
            </CardHeader>
            <CardContent>
              {hotspots.length === 0 ? (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <AlertTriangle className="h-4 w-4" />
                  No hotspots for current filters.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-gray-500">
                        <th className="py-2 pr-3">Species</th>
                        <th className="py-2 pr-3">Items</th>
                        <th className="py-2 pr-3">Priority</th>
                        <th className="py-2 pr-3">Avg Risk</th>
                        <th className="py-2 pr-3">Centroid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {hotspots.map((hotspot) => (
                        <tr key={hotspot.id} className="border-b last:border-b-0">
                          <td className="py-2 pr-3 font-medium text-gray-800">{hotspot.species}</td>
                          <td className="py-2 pr-3">{hotspot.itemCount}</td>
                          <td className="py-2 pr-3">{(hotspot.priorityScore ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3">{(hotspot.avgRiskScore ?? 0).toFixed(2)}</td>
                          <td className="py-2 pr-3 text-xs text-gray-500">
                            {hotspot.centroidLat.toFixed(5)}, {hotspot.centroidLon.toFixed(5)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {loadingRunDetail && (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Refreshing run details...
        </div>
      )}
    </div>
  );
}

