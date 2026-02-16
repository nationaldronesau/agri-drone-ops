"use client";

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Rocket, Loader2, Download, Trash2, Route, MapPinned, Shield, UploadCloud } from 'lucide-react';
import type { Prisma } from '@prisma/client';

const PlanMap = dynamic(() => import('@/components/mission-planner/PlanMap'), {
  ssr: false,
  loading: () => (
    <div className="flex h-[420px] items-center justify-center rounded-lg border border-gray-200 bg-white text-sm text-gray-500">
      Loading map preview...
    </div>
  ),
});

interface Project {
  id: string;
  name: string;
  location: string | null;
}

interface PlanListItem {
  id: string;
  name: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  createdAt: string;
  project: {
    id: string;
    name: string;
    location: string | null;
  };
  _count: {
    missions: number;
    zones: number;
  };
}

interface PlanMission {
  id: string;
  sequence: number;
  name: string;
  zoneCount: number;
  totalAreaHa: number;
  chemicalLiters: number;
  estimatedDistanceM: number;
  estimatedDurationMin: number;
  routeGeoJson: Prisma.JsonValue | null;
  metadata: Prisma.JsonValue | null;
  zones: PlanZone[];
}

interface PlanZone {
  id: string;
  missionId: string | null;
  species: string;
  detectionCount: number;
  averageConfidence: number | null;
  priorityScore: number | null;
  centroidLat: number;
  centroidLon: number;
  areaHa: number;
  recommendedDosePerHa: number | null;
  recommendedLiters: number | null;
  recommendationSource: string | null;
  polygon: Prisma.JsonValue;
}

interface PlanDetail {
  id: string;
  name: string;
  status: string;
  progress: number;
  errorMessage: string | null;
  summary: Prisma.JsonValue | null;
  missions: PlanMission[];
  zones: PlanZone[];
  project: {
    id: string;
    name: string;
    location: string | null;
  };
}

interface ComplianceLayer {
  id: string;
  name: string;
  layerType: 'ALLOWED_AREA' | 'EXCLUSION_AREA' | 'REFERENCE';
  sourceFormat: 'GEOJSON' | 'KML' | 'SHAPEFILE' | 'MANUAL';
  bufferMeters: number;
  isActive: boolean;
  geometry: Prisma.JsonValue;
  projectId: string;
  metadata: Prisma.JsonValue | null;
}

interface GenerationForm {
  name: string;
  classesText: string;
  minConfidence: number;
  zoneRadiusMeters: number;
  minDetectionsPerZone: number;
  maxZonesPerMission: number;
  maxAreaHaPerMission: number;
  maxTankLiters: number;
  droneCruiseSpeedMps: number;
  sprayRateHaPerMin: number;
  defaultDosePerHa: number;
  includeAIDetections: boolean;
  includeManualAnnotations: boolean;
  includeUnverified: boolean;
  returnToStart: boolean;
  includeCompliance: boolean;
  enableWeatherOptimization: boolean;
  weatherLookaheadHours: number;
  maxWindSpeedMps: number;
  maxGustSpeedMps: number;
  maxPrecipProbability: number;
  minTemperatureC: number;
  maxTemperatureC: number;
  missionTurnaroundMinutes: number;
  preferredLaunchTimeLocal: string;
}

const defaultForm: GenerationForm = {
  name: '',
  classesText: '',
  minConfidence: 0.45,
  zoneRadiusMeters: 22,
  minDetectionsPerZone: 2,
  maxZonesPerMission: 16,
  maxAreaHaPerMission: 3.5,
  maxTankLiters: 28,
  droneCruiseSpeedMps: 8,
  sprayRateHaPerMin: 0.28,
  defaultDosePerHa: 1.8,
  includeAIDetections: true,
  includeManualAnnotations: true,
  includeUnverified: false,
  returnToStart: true,
  includeCompliance: true,
  enableWeatherOptimization: true,
  weatherLookaheadHours: 30,
  maxWindSpeedMps: 8,
  maxGustSpeedMps: 11,
  maxPrecipProbability: 35,
  minTemperatureC: 5,
  maxTemperatureC: 35,
  missionTurnaroundMinutes: 8,
  preferredLaunchTimeLocal: '',
};

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'READY') return 'default';
  if (status === 'FAILED') return 'destructive';
  if (status === 'PROCESSING' || status === 'QUEUED') return 'secondary';
  return 'outline';
}

function weatherDecisionVariant(decision: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (decision === 'GO') return 'default';
  if (decision === 'CAUTION') return 'secondary';
  if (decision === 'NO_GO') return 'destructive';
  return 'outline';
}

type ParsedMissionMetadata = {
  routeOptimization: {
    baselineDistanceM: number | null;
    optimizedDistanceM: number | null;
    improvementM: number | null;
    improvementPct: number | null;
  };
  weather: {
    decision: string | null;
    riskScore: number | null;
    startTimeUtc: string | null;
    endTimeUtc: string | null;
    avgWindSpeedMps: number | null;
    maxWindGustMps: number | null;
    maxPrecipProbability: number | null;
    reasons: string[];
  };
};

function parseMissionMetadata(value: Prisma.JsonValue | null): ParsedMissionMetadata {
  const fallback: ParsedMissionMetadata = {
    routeOptimization: {
      baselineDistanceM: null,
      optimizedDistanceM: null,
      improvementM: null,
      improvementPct: null,
    },
    weather: {
      decision: null,
      riskScore: null,
      startTimeUtc: null,
      endTimeUtc: null,
      avgWindSpeedMps: null,
      maxWindGustMps: null,
      maxPrecipProbability: null,
      reasons: [] as string[],
    },
  };

  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const record = value as Record<string, Prisma.JsonValue>;

  if (record.routeOptimization && typeof record.routeOptimization === 'object' && !Array.isArray(record.routeOptimization)) {
    const routeOptimization = record.routeOptimization as Record<string, Prisma.JsonValue>;
    fallback.routeOptimization.baselineDistanceM =
      typeof routeOptimization.baselineDistanceM === 'number' ? routeOptimization.baselineDistanceM : null;
    fallback.routeOptimization.optimizedDistanceM =
      typeof routeOptimization.optimizedDistanceM === 'number' ? routeOptimization.optimizedDistanceM : null;
    fallback.routeOptimization.improvementM =
      typeof routeOptimization.improvementM === 'number' ? routeOptimization.improvementM : null;
    fallback.routeOptimization.improvementPct =
      typeof routeOptimization.improvementPct === 'number' ? routeOptimization.improvementPct : null;
  }

  if (record.weather && typeof record.weather === 'object' && !Array.isArray(record.weather)) {
    const weather = record.weather as Record<string, Prisma.JsonValue>;
    fallback.weather.decision = typeof weather.decision === 'string' ? weather.decision : null;
    fallback.weather.riskScore = typeof weather.riskScore === 'number' ? weather.riskScore : null;
    fallback.weather.startTimeUtc = typeof weather.startTimeUtc === 'string' ? weather.startTimeUtc : null;
    fallback.weather.endTimeUtc = typeof weather.endTimeUtc === 'string' ? weather.endTimeUtc : null;
    fallback.weather.avgWindSpeedMps =
      typeof weather.avgWindSpeedMps === 'number' ? weather.avgWindSpeedMps : null;
    fallback.weather.maxWindGustMps =
      typeof weather.maxWindGustMps === 'number' ? weather.maxWindGustMps : null;
    fallback.weather.maxPrecipProbability =
      typeof weather.maxPrecipProbability === 'number' ? weather.maxPrecipProbability : null;
    fallback.weather.reasons = Array.isArray(weather.reasons)
      ? weather.reasons.filter((reason): reason is string => typeof reason === 'string')
      : [];
  }

  return fallback;
}

export default function MissionPlannerPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [plans, setPlans] = useState<PlanListItem[]>([]);
  const [complianceLayers, setComplianceLayers] = useState<ComplianceLayer[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>('all');
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null);
  const [selectedPlan, setSelectedPlan] = useState<PlanDetail | null>(null);
  const [form, setForm] = useState<GenerationForm>(defaultForm);
  const [layerName, setLayerName] = useState('');
  const [layerType, setLayerType] = useState<'ALLOWED_AREA' | 'EXCLUSION_AREA'>('EXCLUSION_AREA');
  const [layerBufferMeters, setLayerBufferMeters] = useState(20);

  const [loadingProjects, setLoadingProjects] = useState(true);
  const [loadingPlans, setLoadingPlans] = useState(true);
  const [loadingCompliance, setLoadingCompliance] = useState(false);
  const [loadingPlanDetail, setLoadingPlanDetail] = useState(false);
  const [creatingPlan, setCreatingPlan] = useState(false);
  const [uploadingLayer, setUploadingLayer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activePlanIds = useMemo(
    () => plans.filter((plan) => plan.status === 'QUEUED' || plan.status === 'PROCESSING').map((plan) => plan.id),
    [plans]
  );

  const fetchProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const response = await fetch('/api/projects?pageSize=200');
      if (!response.ok) {
        throw new Error('Failed to load projects');
      }
      const data = await response.json();
      setProjects(Array.isArray(data.projects) ? data.projects : []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load projects');
    } finally {
      setLoadingProjects(false);
    }
  }, []);

  const fetchPlans = useCallback(async () => {
    setLoadingPlans(true);
    try {
      const params = new URLSearchParams({ limit: '50', offset: '0' });
      if (selectedProject !== 'all') {
        params.set('projectId', selectedProject);
      }

      const response = await fetch(`/api/spray-plans?${params.toString()}`);
      if (!response.ok) {
        throw new Error('Failed to load plans');
      }

      const data = await response.json();
      const nextPlans: PlanListItem[] = Array.isArray(data.plans) ? data.plans : [];
      setPlans(nextPlans);

      if (selectedPlanId && !nextPlans.some((plan) => plan.id === selectedPlanId)) {
        setSelectedPlanId(nextPlans[0]?.id ?? null);
      }

      if (!selectedPlanId && nextPlans.length > 0) {
        setSelectedPlanId(nextPlans[0].id);
      }
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load plans');
    } finally {
      setLoadingPlans(false);
    }
  }, [selectedProject, selectedPlanId]);

  const fetchPlanDetail = useCallback(async (planId: string) => {
    setLoadingPlanDetail(true);
    try {
      const response = await fetch(`/api/spray-plans/${planId}`);
      if (!response.ok) {
        throw new Error('Failed to load plan details');
      }
      const data = (await response.json()) as PlanDetail;
      setSelectedPlan(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load plan details');
      setSelectedPlan(null);
    } finally {
      setLoadingPlanDetail(false);
    }
  }, []);

  const sourceFormatFromFileName = (fileName: string): 'GEOJSON' | 'KML' | 'SHAPEFILE' => {
    const lower = fileName.toLowerCase();
    if (lower.endsWith('.kml')) return 'KML';
    if (lower.endsWith('.zip') || lower.endsWith('.shp')) return 'SHAPEFILE';
    return 'GEOJSON';
  };

  const parseComplianceGeometryFile = async (file: File): Promise<unknown> => {
    const lower = file.name.toLowerCase();

    if (lower.endsWith('.geojson') || lower.endsWith('.json')) {
      return JSON.parse(await file.text());
    }

    if (lower.endsWith('.kml')) {
      const xmlText = await file.text();
      const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
      const toGeoJSON = await import('@tmcw/togeojson');
      return toGeoJSON.kml(xml);
    }

    if (lower.endsWith('.zip') || lower.endsWith('.shp')) {
      const arrayBuffer = await file.arrayBuffer();
      const shpModule = await import('shpjs');
      const parseShapefile = (shpModule.default ?? shpModule) as (
        data: ArrayBuffer | string
      ) => Promise<unknown>;
      return await parseShapefile(arrayBuffer);
    }

    throw new Error('Unsupported file type. Use GeoJSON (.geojson/.json), KML (.kml), or zipped Shapefile (.zip).');
  };

  const fetchComplianceLayers = useCallback(async (projectIdOverride?: string) => {
    const projectId = projectIdOverride ?? selectedProject;
    if (!projectId || projectId === 'all') {
      setComplianceLayers([]);
      return;
    }

    setLoadingCompliance(true);
    try {
      const response = await fetch(`/api/compliance-layers?projectId=${projectId}`);
      if (!response.ok) {
        throw new Error('Failed to load compliance layers');
      }

      const data = await response.json();
      setComplianceLayers(Array.isArray(data.layers) ? (data.layers as ComplianceLayer[]) : []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : 'Failed to load compliance layers');
    } finally {
      setLoadingCompliance(false);
    }
  }, [selectedProject]);

  const uploadComplianceLayer = async (file: File) => {
    if (selectedProject === 'all') {
      setError('Select a project before adding compliance layers.');
      return;
    }

    setUploadingLayer(true);
    setError(null);

    try {
      const geometry = await parseComplianceGeometryFile(file);
      const sourceFormat = sourceFormatFromFileName(file.name);
      const inferredName = file.name.replace(/\.[^.]+$/, '');

      const response = await fetch('/api/compliance-layers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProject,
          name: layerName.trim() || inferredName || `${layerType} Layer`,
          layerType,
          sourceFormat,
          bufferMeters: layerType === 'EXCLUSION_AREA' ? layerBufferMeters : 0,
          geometry,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to upload compliance layer');
      }

      setLayerName('');
      await fetchComplianceLayers();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Failed to upload compliance layer');
    } finally {
      setUploadingLayer(false);
    }
  };

  const toggleLayerActive = async (layer: ComplianceLayer, isActive: boolean) => {
    try {
      const response = await fetch(`/api/compliance-layers/${layer.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isActive }),
      });
      if (!response.ok) {
        throw new Error('Failed to update compliance layer');
      }

      await fetchComplianceLayers();
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Failed to update compliance layer');
    }
  };

  const removeComplianceLayer = async (layerId: string) => {
    try {
      const response = await fetch(`/api/compliance-layers/${layerId}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        throw new Error('Failed to delete compliance layer');
      }

      await fetchComplianceLayers();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete compliance layer');
    }
  };

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  useEffect(() => {
    void fetchPlans();
  }, [fetchPlans]);

  useEffect(() => {
    void fetchComplianceLayers();
  }, [fetchComplianceLayers]);

  useEffect(() => {
    if (selectedProject !== 'all') return;
    const planProjectId = selectedPlan?.project?.id;
    if (!planProjectId) return;
    void fetchComplianceLayers(planProjectId);
  }, [fetchComplianceLayers, selectedPlan?.project?.id, selectedProject]);

  useEffect(() => {
    if (!selectedPlanId) {
      setSelectedPlan(null);
      return;
    }
    void fetchPlanDetail(selectedPlanId);
  }, [fetchPlanDetail, selectedPlanId]);

  useEffect(() => {
    if (activePlanIds.length === 0) return;

    const timer = setInterval(() => {
      void fetchPlans();
      if (selectedPlanId && activePlanIds.includes(selectedPlanId)) {
        void fetchPlanDetail(selectedPlanId);
      }
    }, 4000);

    return () => clearInterval(timer);
  }, [activePlanIds, fetchPlanDetail, fetchPlans, selectedPlanId]);

  const createPlan = async () => {
    if (selectedProject === 'all') {
      setError('Select a project before generating a spray plan.');
      return;
    }

    setCreatingPlan(true);
    setError(null);

    try {
      const classes = form.classesText
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      const preferredLaunchDate = form.preferredLaunchTimeLocal
        ? new Date(form.preferredLaunchTimeLocal)
        : null;
      const preferredLaunchTimestamp =
        preferredLaunchDate && Number.isFinite(preferredLaunchDate.getTime())
          ? preferredLaunchDate.toISOString()
          : undefined;

      const response = await fetch('/api/spray-plans', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: selectedProject,
          name: form.name || undefined,
          classes,
          minConfidence: form.minConfidence,
          zoneRadiusMeters: form.zoneRadiusMeters,
          minDetectionsPerZone: form.minDetectionsPerZone,
          maxZonesPerMission: form.maxZonesPerMission,
          maxAreaHaPerMission: form.maxAreaHaPerMission,
          maxTankLiters: form.maxTankLiters,
          droneCruiseSpeedMps: form.droneCruiseSpeedMps,
          sprayRateHaPerMin: form.sprayRateHaPerMin,
          defaultDosePerHa: form.defaultDosePerHa,
          includeAIDetections: form.includeAIDetections,
          includeManualAnnotations: form.includeManualAnnotations,
          includeUnverified: form.includeUnverified,
          returnToStart: form.returnToStart,
          includeCompliance: form.includeCompliance,
          enableWeatherOptimization: form.enableWeatherOptimization,
          weatherLookaheadHours: form.weatherLookaheadHours,
          maxWindSpeedMps: form.maxWindSpeedMps,
          maxGustSpeedMps: form.maxGustSpeedMps,
          maxPrecipProbability: form.maxPrecipProbability,
          minTemperatureC: form.minTemperatureC,
          maxTemperatureC: form.maxTemperatureC,
          missionTurnaroundMinutes: form.missionTurnaroundMinutes,
          preferredLaunchTimeUtc: preferredLaunchTimestamp,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to queue spray plan');
      }

      const data = await response.json();
      if (data.planId) {
        setSelectedPlanId(data.planId);
      }

      await fetchPlans();
      if (data.planId) {
        await fetchPlanDetail(data.planId);
      }
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Failed to create plan');
    } finally {
      setCreatingPlan(false);
    }
  };

  const deletePlan = async (planId: string) => {
    if (!confirm('Delete this spray plan and all generated missions?')) return;

    try {
      const response = await fetch(`/api/spray-plans/${planId}`, { method: 'DELETE' });
      if (!response.ok) {
        throw new Error('Failed to delete spray plan');
      }

      if (selectedPlanId === planId) {
        setSelectedPlanId(null);
        setSelectedPlan(null);
      }

      await fetchPlans();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete spray plan');
    }
  };

  const summary = (selectedPlan?.summary as Record<string, unknown> | null) ?? null;
  const totals =
    summary && typeof summary.totals === 'object' && summary.totals
      ? (summary.totals as Record<string, unknown>)
      : null;
  const complianceSummary =
    summary && typeof summary.compliance === 'object' && summary.compliance
      ? (summary.compliance as Record<string, unknown>)
      : null;
  const optimizationSummary =
    summary && typeof summary.optimization === 'object' && summary.optimization
      ? (summary.optimization as Record<string, unknown>)
      : null;
  const weatherSummary =
    summary && typeof summary.weather === 'object' && summary.weather
      ? (summary.weather as Record<string, unknown>)
      : null;

  return (
    <div className="space-y-6 p-6 lg:p-8">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Mission Planner</h1>
          <p className="text-sm text-gray-600">
            Generate spray zones and battery-aware sorties from detections and annotations.
          </p>
        </div>
        <Badge variant="outline" className="px-3 py-1 text-xs">
          v1 Autoplanner
        </Badge>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[420px,1fr]">
        <div className="space-y-6">
          <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <Rocket className="h-5 w-5 text-blue-600" />
              Generate Plan
            </CardTitle>
            <CardDescription>Configure mission constraints and queue a new spray plan.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="project">Project</Label>
              <Select value={selectedProject} onValueChange={setSelectedProject} disabled={loadingProjects}>
                <SelectTrigger id="project">
                  <SelectValue placeholder={loadingProjects ? 'Loading projects...' : 'Select project'} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                      {project.location ? ` - ${project.location}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Plan Name (optional)</Label>
              <Input
                id="name"
                value={form.name}
                placeholder="Auto-generated if empty"
                onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="classes">Species Filter (comma-separated)</Label>
              <Input
                id="classes"
                value={form.classesText}
                placeholder="e.g. Lantana, Wattle"
                onChange={(event) => setForm((prev) => ({ ...prev, classesText: event.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="minConfidence">Min Confidence</Label>
                <Input
                  id="minConfidence"
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={form.minConfidence}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, minConfidence: Number(event.target.value) || 0 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="zoneRadiusMeters">Zone Radius (m)</Label>
                <Input
                  id="zoneRadiusMeters"
                  type="number"
                  min={8}
                  step={1}
                  value={form.zoneRadiusMeters}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, zoneRadiusMeters: Number(event.target.value) || 8 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxZonesPerMission">Max Zones/Mission</Label>
                <Input
                  id="maxZonesPerMission"
                  type="number"
                  min={1}
                  step={1}
                  value={form.maxZonesPerMission}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, maxZonesPerMission: Number(event.target.value) || 1 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="minDetectionsPerZone">Min Detections/Zone</Label>
                <Input
                  id="minDetectionsPerZone"
                  type="number"
                  min={1}
                  step={1}
                  value={form.minDetectionsPerZone}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, minDetectionsPerZone: Number(event.target.value) || 1 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxAreaHaPerMission">Max Area/Mission (ha)</Label>
                <Input
                  id="maxAreaHaPerMission"
                  type="number"
                  min={0.2}
                  step={0.1}
                  value={form.maxAreaHaPerMission}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, maxAreaHaPerMission: Number(event.target.value) || 0.2 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="maxTankLiters">Tank Capacity (L)</Label>
                <Input
                  id="maxTankLiters"
                  type="number"
                  min={1}
                  step={0.5}
                  value={form.maxTankLiters}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, maxTankLiters: Number(event.target.value) || 1 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="droneCruiseSpeedMps">Cruise Speed (m/s)</Label>
                <Input
                  id="droneCruiseSpeedMps"
                  type="number"
                  min={1}
                  step={0.5}
                  value={form.droneCruiseSpeedMps}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, droneCruiseSpeedMps: Number(event.target.value) || 1 }))
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="sprayRateHaPerMin">Spray Rate (ha/min)</Label>
                <Input
                  id="sprayRateHaPerMin"
                  type="number"
                  min={0.01}
                  step={0.01}
                  value={form.sprayRateHaPerMin}
                  onChange={(event) =>
                    setForm((prev) => ({ ...prev, sprayRateHaPerMin: Number(event.target.value) || 0.01 }))
                  }
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="defaultDosePerHa">Fallback Dose (L/ha)</Label>
              <Input
                id="defaultDosePerHa"
                type="number"
                min={0.01}
                step={0.1}
                value={form.defaultDosePerHa}
                onChange={(event) =>
                  setForm((prev) => ({ ...prev, defaultDosePerHa: Number(event.target.value) || 0.01 }))
                }
              />
            </div>

            <div className="space-y-3 rounded-md border border-cyan-200 bg-cyan-50/40 p-3">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-cyan-900">Weather & Drift Optimization</p>
                  <p className="text-xs text-cyan-800">
                    Scores launch windows and mission risk from forecast wind, gusts, precipitation, and temperature.
                  </p>
                </div>
                <Checkbox
                  id="enableWeatherOptimization"
                  checked={form.enableWeatherOptimization}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, enableWeatherOptimization: checked === true }))
                  }
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="weatherLookaheadHours">Lookahead (hours)</Label>
                  <Input
                    id="weatherLookaheadHours"
                    type="number"
                    min={6}
                    max={72}
                    step={1}
                    disabled={!form.enableWeatherOptimization}
                    value={form.weatherLookaheadHours}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        weatherLookaheadHours: Number.isFinite(nextValue) ? nextValue : 6,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="missionTurnaroundMinutes">Turnaround (min)</Label>
                  <Input
                    id="missionTurnaroundMinutes"
                    type="number"
                    min={0}
                    max={120}
                    step={1}
                    disabled={!form.enableWeatherOptimization}
                    value={form.missionTurnaroundMinutes}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        missionTurnaroundMinutes: Number.isFinite(nextValue) ? nextValue : 0,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxWindSpeedMps">Max Wind (m/s)</Label>
                  <Input
                    id="maxWindSpeedMps"
                    type="number"
                    min={2}
                    max={25}
                    step={0.1}
                    disabled={!form.enableWeatherOptimization}
                    value={form.maxWindSpeedMps}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        maxWindSpeedMps: Number.isFinite(nextValue) ? nextValue : 2,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxGustSpeedMps">Max Gust (m/s)</Label>
                  <Input
                    id="maxGustSpeedMps"
                    type="number"
                    min={3}
                    max={35}
                    step={0.1}
                    disabled={!form.enableWeatherOptimization}
                    value={form.maxGustSpeedMps}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        maxGustSpeedMps: Number.isFinite(nextValue) ? nextValue : 3,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxPrecipProbability">Max Precip (%)</Label>
                  <Input
                    id="maxPrecipProbability"
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    disabled={!form.enableWeatherOptimization}
                    value={form.maxPrecipProbability}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        maxPrecipProbability: Number.isFinite(nextValue) ? nextValue : 0,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="preferredLaunchTimeLocal">Preferred Launch (local)</Label>
                  <Input
                    id="preferredLaunchTimeLocal"
                    type="datetime-local"
                    disabled={!form.enableWeatherOptimization}
                    value={form.preferredLaunchTimeLocal}
                    onChange={(event) =>
                      setForm((prev) => ({ ...prev, preferredLaunchTimeLocal: event.target.value }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="minTemperatureC">Min Temp (°C)</Label>
                  <Input
                    id="minTemperatureC"
                    type="number"
                    min={-10}
                    max={35}
                    step={0.5}
                    disabled={!form.enableWeatherOptimization}
                    value={form.minTemperatureC}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        minTemperatureC: Number.isFinite(nextValue) ? nextValue : -10,
                      }));
                    }}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="maxTemperatureC">Max Temp (°C)</Label>
                  <Input
                    id="maxTemperatureC"
                    type="number"
                    min={5}
                    max={50}
                    step={0.5}
                    disabled={!form.enableWeatherOptimization}
                    value={form.maxTemperatureC}
                    onChange={(event) => {
                      const nextValue = Number(event.target.value);
                      setForm((prev) => ({
                        ...prev,
                        maxTemperatureC: Number.isFinite(nextValue) ? nextValue : 5,
                      }));
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="space-y-2 rounded-md border border-gray-200 p-3">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeAIDetections"
                  checked={form.includeAIDetections}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, includeAIDetections: checked === true }))
                  }
                />
                <Label htmlFor="includeAIDetections">Include AI detections</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeManualAnnotations"
                  checked={form.includeManualAnnotations}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, includeManualAnnotations: checked === true }))
                  }
                />
                <Label htmlFor="includeManualAnnotations">Include manual annotations</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeUnverified"
                  checked={form.includeUnverified}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, includeUnverified: checked === true }))
                  }
                />
                <Label htmlFor="includeUnverified">Include unverified points</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="returnToStart"
                  checked={form.returnToStart}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, returnToStart: checked === true }))
                  }
                />
                <Label htmlFor="returnToStart">Return route to start</Label>
              </div>
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="includeCompliance"
                  checked={form.includeCompliance}
                  onCheckedChange={(checked) =>
                    setForm((prev) => ({ ...prev, includeCompliance: checked === true }))
                  }
                />
                <Label htmlFor="includeCompliance">Apply compliance layers</Label>
              </div>
            </div>

            <Button onClick={createPlan} disabled={creatingPlan || loadingProjects} className="w-full">
              {creatingPlan ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Queuing...
                </>
              ) : (
                <>
                  <Rocket className="mr-2 h-4 w-4" />
                  Generate Spray Plan
                </>
              )}
            </Button>
          </CardContent>
        </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <Shield className="h-5 w-5 text-emerald-600" />
                Compliance Layers
              </CardTitle>
              <CardDescription>
                Upload allowed/exclusion boundaries (GeoJSON, KML, zipped Shapefile) and apply buffers.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="layerName">Layer Name (optional)</Label>
                <Input
                  id="layerName"
                  value={layerName}
                  placeholder="Auto-inferred from file name"
                  onChange={(event) => setLayerName(event.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="layerType">Layer Type</Label>
                  <Select
                    value={layerType}
                    onValueChange={(value) => setLayerType(value as 'ALLOWED_AREA' | 'EXCLUSION_AREA')}
                  >
                    <SelectTrigger id="layerType">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="EXCLUSION_AREA">No-Spray Zone</SelectItem>
                      <SelectItem value="ALLOWED_AREA">Allowed Spray Area</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="layerBufferMeters">Buffer (m)</Label>
                  <Input
                    id="layerBufferMeters"
                    type="number"
                    min={0}
                    step={1}
                    value={layerBufferMeters}
                    disabled={layerType !== 'EXCLUSION_AREA'}
                    onChange={(event) => setLayerBufferMeters(Math.max(0, Number(event.target.value) || 0))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="layerFile">Boundary File</Label>
                <Input
                  id="layerFile"
                  type="file"
                  accept=".geojson,.json,.kml,.zip,.shp"
                  disabled={uploadingLayer || selectedProject === 'all'}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void uploadComplianceLayer(file);
                    }
                    event.currentTarget.value = '';
                  }}
                />
                {selectedProject === 'all' && (
                  <p className="text-xs text-amber-600">Select a specific project to manage compliance layers.</p>
                )}
              </div>

              <div className="rounded-md border border-gray-200 p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-900">Project Layers</p>
                  {loadingCompliance ? (
                    <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
                  ) : (
                    <Badge variant="outline">{complianceLayers.length}</Badge>
                  )}
                </div>

                {uploadingLayer && (
                  <div className="mb-2 flex items-center gap-2 text-xs text-blue-700">
                    <UploadCloud className="h-3.5 w-3.5" />
                    Uploading and normalizing layer...
                  </div>
                )}

                {complianceLayers.length === 0 ? (
                  <p className="text-xs text-gray-500">No compliance layers for this project yet.</p>
                ) : (
                  <div className="space-y-2">
                    {complianceLayers.map((layer) => (
                      <div
                        key={layer.id}
                        className={`rounded border px-2 py-2 ${layer.isActive ? 'border-emerald-200 bg-emerald-50/40' : 'border-gray-200 bg-gray-50'}`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <p className="truncate text-xs font-medium text-gray-900">{layer.name}</p>
                          <div className="flex items-center gap-1">
                            <Badge variant={layer.isActive ? 'default' : 'outline'} className="text-[10px]">
                              {layer.isActive ? 'Active' : 'Disabled'}
                            </Badge>
                          </div>
                        </div>
                        <p className="text-[11px] text-gray-600">
                          {layer.layerType === 'ALLOWED_AREA' ? 'Allowed area' : 'Exclusion area'} • {layer.sourceFormat}
                          {layer.layerType === 'EXCLUSION_AREA' ? ` • ${layer.bufferMeters.toFixed(1)}m buffer` : ''}
                        </p>
                        <div className="mt-2 flex gap-1">
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => void toggleLayerActive(layer, !layer.isActive)}
                          >
                            {layer.isActive ? 'Disable' : 'Enable'}
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[11px]"
                            onClick={() => void removeComplianceLayer(layer.id)}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Recent Plans</CardTitle>
              <CardDescription>Select a plan to inspect missions and download outputs.</CardDescription>
            </CardHeader>
            <CardContent>
              {loadingPlans ? (
                <p className="text-sm text-gray-500">Loading plans...</p>
              ) : plans.length === 0 ? (
                <p className="text-sm text-gray-500">No spray plans yet for this scope.</p>
              ) : (
                <div className="space-y-2">
                  {plans.map((plan) => (
                    <button
                      key={plan.id}
                      onClick={() => setSelectedPlanId(plan.id)}
                      className={`w-full rounded-md border px-3 py-2 text-left transition-colors ${
                        selectedPlanId === plan.id
                          ? 'border-blue-300 bg-blue-50'
                          : 'border-gray-200 bg-white hover:border-gray-300'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <p className="truncate text-sm font-medium text-gray-900">{plan.name}</p>
                        <Badge variant={statusVariant(plan.status)}>{plan.status}</Badge>
                      </div>
                      <p className="mt-1 text-xs text-gray-600">
                        {plan.project.name} • {plan._count.missions} missions • {plan._count.zones} zones
                      </p>
                      {(plan.status === 'PROCESSING' || plan.status === 'QUEUED') && (
                        <div className="mt-2 h-1.5 w-full overflow-hidden rounded bg-gray-200">
                          <div className="h-full bg-blue-500" style={{ width: `${Math.max(5, plan.progress)}%` }} />
                        </div>
                      )}
                      {plan.errorMessage && <p className="mt-2 text-xs text-red-600">{plan.errorMessage}</p>}
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {selectedPlan && (
            <>
              <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                  <div>
                    <CardTitle className="text-lg">{selectedPlan.name}</CardTitle>
                    <CardDescription>
                      {selectedPlan.project.name}
                      {selectedPlan.project.location ? ` - ${selectedPlan.project.location}` : ''}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusVariant(selectedPlan.status)}>{selectedPlan.status}</Badge>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void fetchPlanDetail(selectedPlan.id)}
                      disabled={loadingPlanDetail}
                    >
                      {loadingPlanDetail ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Refresh'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => window.open(`/api/spray-plans/${selectedPlan.id}/export`, '_blank')}
                      disabled={selectedPlan.status !== 'READY'}
                    >
                      <Download className="mr-2 h-4 w-4" />
                      Export Pack
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void deletePlan(selectedPlan.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {selectedPlan.errorMessage && (
                    <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                      {selectedPlan.errorMessage}
                    </div>
                  )}

                  {totals && (
                    <div className="mb-4 grid gap-3 sm:grid-cols-4">
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Source Points</p>
                        <p className="text-lg font-semibold text-gray-900">
                          {Number(totals.sourcePointCount ?? 0).toLocaleString()}
                        </p>
                      </div>
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Zones</p>
                        <p className="text-lg font-semibold text-gray-900">{Number(totals.zoneCount ?? 0)}</p>
                      </div>
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Area (ha)</p>
                        <p className="text-lg font-semibold text-gray-900">
                          {Number(totals.totalAreaHa ?? 0).toFixed(2)}
                        </p>
                      </div>
                      <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                        <p className="text-xs text-gray-500">Chemical (L)</p>
                        <p className="text-lg font-semibold text-gray-900">
                          {Number(totals.totalChemicalLiters ?? 0).toFixed(2)}
                        </p>
                      </div>
                    </div>
                  )}

                  {complianceSummary && (
                    <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-emerald-700">
                        Compliance Report
                      </p>
                      <div className="grid gap-2 text-xs text-emerald-800 sm:grid-cols-3">
                        <div>Layers Applied: {Number(complianceSummary.layerCount ?? 0)}</div>
                        <div>Excluded Zones: {Number(complianceSummary.fullyExcludedZones ?? 0)}</div>
                        <div>Split Zones: {Number(complianceSummary.splitZonesCreated ?? 0)}</div>
                        <div>Excluded Area: {Number(complianceSummary.excludedAreaHa ?? 0).toFixed(2)} ha</div>
                        <div>Allowed Layers: {Number(complianceSummary.allowedLayerCount ?? 0)}</div>
                        <div>Exclusion Layers: {Number(complianceSummary.exclusionLayerCount ?? 0)}</div>
                      </div>
                    </div>
                  )}

                  {optimizationSummary && (
                    <div className="mb-4 rounded-md border border-blue-200 bg-blue-50 p-3">
                      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-blue-700">
                        Route Optimization
                      </p>
                      <div className="grid gap-2 text-xs text-blue-900 sm:grid-cols-4">
                        <div>Algorithm: {String(optimizationSummary.routeAlgorithm ?? 'n/a')}</div>
                        <div>
                          Baseline: {(Number(optimizationSummary.baselineDistanceM ?? 0) / 1000).toFixed(2)} km
                        </div>
                        <div>
                          Optimized: {(Number(optimizationSummary.optimizedDistanceM ?? 0) / 1000).toFixed(2)} km
                        </div>
                        <div>
                          Saved: {(Number(optimizationSummary.savedDistanceM ?? 0) / 1000).toFixed(2)} km (
                          {Number(optimizationSummary.savedDistancePct ?? 0).toFixed(2)}%)
                        </div>
                      </div>
                    </div>
                  )}

                  {weatherSummary && (
                    <div className="mb-4 rounded-md border border-cyan-200 bg-cyan-50 p-3">
                      <div className="mb-2 flex items-center justify-between gap-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-cyan-700">
                          Weather Window
                        </p>
                        <Badge variant={weatherDecisionVariant(String(weatherSummary.overallDecision ?? 'UNKNOWN'))}>
                          {String(weatherSummary.overallDecision ?? 'UNKNOWN')}
                        </Badge>
                      </div>
                      <div className="grid gap-2 text-xs text-cyan-900 sm:grid-cols-3">
                        <div>Optimization Used: {String(Boolean(weatherSummary.used))}</div>
                        <div>Provider: {String(weatherSummary.provider ?? 'n/a')}</div>
                        <div>Forecast Points: {Number(weatherSummary.forecastPointCount ?? 0)}</div>
                        <div>
                          Launch: {weatherSummary.recommendedLaunchTimeUtc
                            ? new Date(String(weatherSummary.recommendedLaunchTimeUtc)).toLocaleString()
                            : 'n/a'}
                        </div>
                        <div>Risk Score: {Number(weatherSummary.averageRiskScore ?? 0).toFixed(3)}</div>
                        <div>No-Go Missions: {Number(weatherSummary.noGoMissionCount ?? 0)}</div>
                      </div>
                      {Array.isArray(weatherSummary.notes) && weatherSummary.notes.length > 0 && (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-cyan-800">
                          {weatherSummary.notes
                            .filter((note): note is string => typeof note === 'string')
                            .slice(0, 4)
                            .map((note) => (
                              <li key={note}>{note}</li>
                            ))}
                        </ul>
                      )}
                    </div>
                  )}

                  {(selectedPlan.status === 'PROCESSING' || selectedPlan.status === 'QUEUED') && (
                    <div className="mb-4">
                      <div className="mb-2 flex items-center justify-between text-sm text-gray-600">
                        <span>Generating...</span>
                        <span>{selectedPlan.progress}%</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded bg-gray-200">
                        <div className="h-full bg-blue-500 transition-all" style={{ width: `${Math.max(5, selectedPlan.progress)}%` }} />
                      </div>
                    </div>
                  )}

                  {selectedPlan.missions.length > 0 && (
                    <div className="space-y-4">
                      <div>
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900">
                          <Route className="h-4 w-4" />
                          Missions
                        </h3>
                        <div className="overflow-hidden rounded-md border border-gray-200">
                          <table className="w-full text-left text-sm">
                            <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                              <tr>
                                <th className="px-3 py-2">Mission</th>
                                <th className="px-3 py-2">Zones</th>
                                <th className="px-3 py-2">Area (ha)</th>
                                <th className="px-3 py-2">Chemical (L)</th>
                                <th className="px-3 py-2">Distance (km)</th>
                                <th className="px-3 py-2">Saved (m)</th>
                                <th className="px-3 py-2">Weather</th>
                                <th className="px-3 py-2">Risk</th>
                                <th className="px-3 py-2">Planned Start</th>
                                <th className="px-3 py-2">Duration (min)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {selectedPlan.missions.map((mission) => {
                                const metadata = parseMissionMetadata(mission.metadata);
                                return (
                                  <tr key={mission.id} className="border-t border-gray-100">
                                    <td className="px-3 py-2 font-medium text-gray-900">{mission.name}</td>
                                    <td className="px-3 py-2">{mission.zoneCount}</td>
                                    <td className="px-3 py-2">{mission.totalAreaHa.toFixed(3)}</td>
                                    <td className="px-3 py-2">{mission.chemicalLiters.toFixed(2)}</td>
                                    <td className="px-3 py-2">{(mission.estimatedDistanceM / 1000).toFixed(2)}</td>
                                    <td className="px-3 py-2">
                                      {(metadata.routeOptimization.improvementM ?? 0).toFixed(1)}
                                    </td>
                                    <td className="px-3 py-2">
                                      <Badge variant={weatherDecisionVariant(metadata.weather.decision ?? 'UNKNOWN')}>
                                        {metadata.weather.decision ?? 'n/a'}
                                      </Badge>
                                    </td>
                                    <td className="px-3 py-2">
                                      {metadata.weather.riskScore != null ? metadata.weather.riskScore.toFixed(3) : 'n/a'}
                                    </td>
                                    <td className="px-3 py-2">
                                      {metadata.weather.startTimeUtc
                                        ? new Date(metadata.weather.startTimeUtc).toLocaleString()
                                        : 'n/a'}
                                    </td>
                                    <td className="px-3 py-2">{mission.estimatedDurationMin.toFixed(1)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>

                      <div>
                        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-900">
                          <MapPinned className="h-4 w-4" />
                          Zone & Route Preview
                        </h3>
                        <PlanMap
                          zones={selectedPlan.zones}
                          missions={selectedPlan.missions}
                          complianceLayers={complianceLayers}
                        />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>

              {selectedPlan.zones.length > 0 && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-lg">Zones</CardTitle>
                    <CardDescription>Species clusters and spray dosage recommendations.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="w-full min-w-[780px] text-left text-sm">
                        <thead className="bg-gray-50 text-xs uppercase text-gray-500">
                          <tr>
                            <th className="px-3 py-2">Species</th>
                            <th className="px-3 py-2">Detections</th>
                            <th className="px-3 py-2">Confidence</th>
                            <th className="px-3 py-2">Area (ha)</th>
                            <th className="px-3 py-2">Dose (L/ha)</th>
                            <th className="px-3 py-2">Liters</th>
                            <th className="px-3 py-2">Source</th>
                          </tr>
                        </thead>
                        <tbody>
                          {selectedPlan.zones.slice(0, 120).map((zone) => (
                            <tr key={zone.id} className="border-t border-gray-100">
                              <td className="px-3 py-2 font-medium text-gray-900">{zone.species}</td>
                              <td className="px-3 py-2">{zone.detectionCount}</td>
                              <td className="px-3 py-2">{(zone.averageConfidence ?? 0).toFixed(2)}</td>
                              <td className="px-3 py-2">{zone.areaHa.toFixed(4)}</td>
                              <td className="px-3 py-2">{(zone.recommendedDosePerHa ?? 0).toFixed(2)}</td>
                              <td className="px-3 py-2">{(zone.recommendedLiters ?? 0).toFixed(3)}</td>
                              <td className="px-3 py-2">{zone.recommendationSource ?? 'n/a'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {selectedPlan.zones.length > 120 && (
                      <p className="mt-2 text-xs text-gray-500">
                        Showing first 120 zones in the table. Full data is included in export pack.
                      </p>
                    )}
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
