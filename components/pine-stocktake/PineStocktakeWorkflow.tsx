'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Check, CircleHelp, Download, GitBranch, Layers3, Loader2, MapPinned, Play, RotateCcw, Save, ScanSearch, ShieldCheck, Trash2, UploadCloud } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Point = [number, number];
type Candidate = {
  id: string;
  candidateId: string;
  exemplarId: string;
  targetAssetId: string;
  targetImageSha256: string;
  nativePolygon: Point[];
  score: number;
  targetAsset: { id: string; fileName: string; storageUrl: string; thumbnailUrl: string | null; imageWidth: number | null; imageHeight: number | null };
};
type AgreementGroup = { id: string; agreementId: string; agreementLevel: 1 | 2 | 3; scoresByExemplar: Record<string, number>; nativePolygon: Point[]; members: { candidateId: string; candidate: Candidate }[] };
type AcceptedCrownRow = { id: string; crownId: string; agreementLevel: number; edgeClipped: boolean; lidarAssociation: { status: string; x: number | null; y: number | null; apexX: number | null; apexY: number | null; heightP99M: number | null; heightMaxValidM: number | null; missingReason: string | null } | null };
type FlatMapOutputs = { previewPng?: { url: string; sha256: string }; browserViewer?: { url: string; sha256: string }; previewBounds?: [number, number, number, number] };
type Payload = {
  job: {
    id: string; status: string; stage: string; progress: number; failureReason: string | null; targetCrs: string | null; poseTimebase: string | null;
    modelRepository: string; modelRevision: string; modelWeightSha256: string; runnerCommit: string | null; runnerTreeSha256: string | null; immutableManifestSha256: string;
    project: { id: string; name: string; location: string | null };
    missionFiles: { id: string; kind: string; assetId: string | null; fileName: string; sha256: string; cameraSerial: string | null; timebase: string | null; crs: string | null }[];
    exemplars: { id: string; sourceAssetId: string; sourceImageSha256: string; exemplarSha256: string; approved: boolean; sourceAsset: { fileName: string; thumbnailUrl: string | null; storageUrl: string; imageWidth: number | null; imageHeight: number | null } }[];
    inferenceRuns: { id: string; exemplarId: string; targetAssetId: string; status: string; attemptCount: number; failureReason: string | null }[];
    agreementGroups: AgreementGroup[];
    acceptedCrowns: AcceptedCrownRow[];
    flatMapResult: { status: string; approximate: boolean; projectedCrs: string; outputs: FlatMapOutputs } | null;
  };
  summary: { candidate: number; accepted: number; rejected: number; unsure: number; missedAdded: number; missingLidar: number };
};

const stages = [
  { key: 'UPLOAD_VALIDATE', label: '1. Upload and validate mission', icon: UploadCloud },
  { key: 'EXEMPLARS_DETECT', label: '2. Select exemplars and detect', icon: ScanSearch },
  { key: 'REVIEW_CROWNS', label: '3. Review and correct crowns', icon: ShieldCheck },
  { key: 'MAP_HEIGHT_EXPORT', label: '4. Map, deduplicate and calculate heights', icon: MapPinned },
] as const;

function statusTone(status: string) {
  if (status === 'COMPLETED') return 'bg-green-100 text-green-800';
  if (status === 'FAILED' || status === 'BLOCKED') return 'bg-red-100 text-red-800';
  if (status === 'REVIEW_REQUIRED') return 'bg-amber-100 text-amber-900';
  return 'bg-blue-100 text-blue-800';
}

export function PineStocktakeWorkflow({ jobId }: { jobId: string }) {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [agreementFilter, setAgreementFilter] = useState('all');
  const [selectedAgreementId, setSelectedAgreementId] = useState<string | null>(null);
  const [queueing, setQueueing] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const response = await fetch(`/api/pine-stocktake/jobs/${jobId}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to load Pine Stocktake job');
      setPayload(data);
      setSelectedAgreementId((current) => current ?? data.job.agreementGroups[0]?.agreementId ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load Pine Stocktake job');
    } finally {
      setLoading(false);
    }
  }, [jobId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const enqueue = async (stage: string) => {
    setQueueing(stage);
    setError(null);
    try {
      const response = await fetch(`/api/pine-stocktake/jobs/${jobId}/stage`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stage, idempotencyKey: `${stage}-${payload?.job.immutableManifestSha256.slice(0, 16)}` }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to queue stage');
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to queue stage');
    } finally {
      setQueueing(null);
    }
  };

  const filteredGroups = useMemo(() => payload?.job.agreementGroups.filter((group) => agreementFilter === 'all' || group.agreementLevel === Number(agreementFilter)) ?? [], [payload, agreementFilter]);
  const selected = payload?.job.agreementGroups.find((group) => group.agreementId === selectedAgreementId) ?? filteredGroups[0];

  if (loading) return <div className="flex min-h-[420px] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin" aria-label="Loading Pine Stocktake" /></div>;
  if (!payload) return <div className="p-6"><p className="text-red-700">{error ?? 'Pine Stocktake job not found'}</p></div>;
  const { job, summary } = payload;
  const processedImages = new Set(job.inferenceRuns.filter((run) => run.status === 'completed').map((run) => run.targetAssetId)).size;
  const imageCount = job.missionFiles.filter((file) => file.kind === 'IMAGE_LV' || file.kind === 'IMAGE_RV').length;

  return (
    <main className="min-h-screen bg-gray-50">
      <header className="bg-gradient-to-r from-emerald-700 to-sky-700 text-white">
        <div className="container mx-auto px-4 py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><Link href="/orthomosaics" className="text-sm text-emerald-100 hover:text-white">← Orthomosaics</Link><h1 className="mt-2 text-3xl font-semibold">Pine Stocktake</h1><p className="mt-1 text-emerald-100">{job.project.name}{job.project.location ? ` · ${job.project.location}` : ''}</p></div>
            <Badge className={statusTone(job.status)}>{job.status.replaceAll('_', ' ')}</Badge>
          </div>
        </div>
      </header>

      <div className="container mx-auto space-y-6 p-6">
        {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>}
        {job.failureReason && <div role="alert" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{job.failureReason}</div>}

        <ol className="grid gap-3 md:grid-cols-4" aria-label="Pine Stocktake stages">
          {stages.map((stage, index) => { const Icon = stage.icon; const active = job.stage === stage.key; const passed = stages.findIndex((item) => item.key === job.stage) > index; return <li key={stage.key} className={`rounded-lg border p-4 ${active ? 'border-emerald-600 bg-emerald-50' : 'border-gray-200 bg-white'}`} aria-current={active ? 'step' : undefined}><div className="flex items-center gap-2"><Icon className="h-5 w-5" /><span className="text-sm font-medium">{stage.label}</span>{passed && <Check className="ml-auto h-4 w-4 text-emerald-700" />}</div></li>; })}
        </ol>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-6" aria-label="Stocktake counts">
          {[
            ['Images', `${processedImages}/${imageCount}`], ['Candidates', summary.candidate], ['Accepted', summary.accepted], ['Rejected', summary.rejected], ['Unsure', summary.unsure], ['Missed added', summary.missedAdded],
          ].map(([label, value]) => <Card key={label}><CardContent className="pt-5"><div className="text-sm text-muted-foreground">{label}</div><div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div></CardContent></Card>)}
        </section>

        <div className="grid gap-6 xl:grid-cols-3">
          <div className="space-y-6 xl:col-span-2">
            <Card>
              <CardHeader><CardTitle>Mission and identities</CardTitle><CardDescription>Precise mapping stays blocked until the mission, serial, pose timebase and CRS identities pass.</CardDescription></CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-3 md:grid-cols-3"><Identity label="SAM3" value={`${job.modelRepository}@${job.modelRevision.slice(0, 12)}`} detail={job.modelWeightSha256} /><Identity label="Flat Map runner" value={job.runnerCommit?.slice(0, 12) ?? 'Not recorded'} detail="Approximate imagery layer only" /><Identity label="Mapping frame" value={job.targetCrs ?? 'Blocked'} detail={job.poseTimebase ?? 'Timebase not proven'} /></div>
                <div className="max-h-56 overflow-auto rounded-md border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-gray-50"><tr><th className="p-2">Type</th><th className="p-2">File</th><th className="p-2">Identity</th></tr></thead><tbody>{job.missionFiles.map((file) => <tr key={file.id} className="border-t"><td className="p-2">{file.kind}</td><td className="p-2">{file.fileName}</td><td className="p-2 font-mono text-xs">{file.sha256.slice(0, 12)}…</td></tr>)}</tbody></table></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>Exemplar bank and independent runs</CardTitle><CardDescription>Three approved crowns from images outside each target run separately. Target annotations cannot enter the prompt set.</CardDescription></div><Button onClick={() => enqueue('detect_exemplars')} disabled={queueing != null || job.exemplars.filter((item) => item.approved).length !== 3}>{queueing === 'detect_exemplars' ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}Detect</Button></CardHeader>
              <CardContent className="space-y-4"><div className="grid gap-3 md:grid-cols-3">{job.exemplars.map((exemplar, index) => <div key={exemplar.id} className="overflow-hidden rounded-md border bg-white"><svg role="img" aria-label={`${exemplar.sourceAsset.fileName} exemplar`} viewBox={`0 0 ${exemplar.sourceAsset.imageWidth ?? 3} ${exemplar.sourceAsset.imageHeight ?? 2}`} className="aspect-video w-full bg-gray-100"><image href={exemplar.sourceAsset.thumbnailUrl ?? exemplar.sourceAsset.storageUrl} width={exemplar.sourceAsset.imageWidth ?? 3} height={exemplar.sourceAsset.imageHeight ?? 2} preserveAspectRatio="xMidYMid slice" /></svg><div className="p-3"><div className="flex items-center justify-between"><span className="font-medium">Exemplar {index + 1}</span><Badge variant={exemplar.approved ? 'default' : 'secondary'}>{exemplar.approved ? 'Approved' : 'Draft'}</Badge></div><p className="mt-1 truncate text-xs">{exemplar.sourceAsset.fileName}</p><p className="mt-2 font-mono text-xs text-muted-foreground">{exemplar.exemplarSha256.slice(0, 16)}…</p><p className="mt-2 text-xs">{job.inferenceRuns.filter((run) => run.exemplarId === exemplar.id && run.status === 'completed').length} target images complete</p></div></div>)}</div>{job.exemplars.length < 3 && <PineExemplarSelector jobId={job.id} projectId={job.project.id} targetAssetIds={job.missionFiles.flatMap((file) => file.assetId ? [file.assetId] : [])} onSaved={refresh} />}</CardContent>
            </Card>

            <Card>
              <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Crown review</CardTitle><CardDescription>The union stays in review. Agreement is evidence, not automatic acceptance.</CardDescription></div><Select value={agreementFilter} onValueChange={setAgreementFilter}><SelectTrigger className="w-48" aria-label="Agreement filter"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All agreement</SelectItem><SelectItem value="1">One of three</SelectItem><SelectItem value="2">Two of three</SelectItem><SelectItem value="3">Three of three</SelectItem></SelectContent></Select></div></CardHeader>
              <CardContent className="grid gap-4 lg:grid-cols-[240px_1fr]"><div className="max-h-[540px] space-y-2 overflow-auto">{filteredGroups.map((group) => <button key={group.id} type="button" onClick={() => setSelectedAgreementId(group.agreementId)} className={`w-full rounded-md border p-3 text-left ${selected?.id === group.id ? 'border-emerald-600 bg-emerald-50' : 'bg-white'}`}><div className="flex justify-between"><span className="font-medium">{group.agreementId}</span><Badge variant="outline">{group.agreementLevel}/3</Badge></div><div className="mt-2 text-xs text-muted-foreground">{group.members.map((member) => `${member.candidate.exemplarId}: ${member.candidate.score.toFixed(2)}`).join(' · ')}</div></button>)}</div>{selected ? <CrownEditor jobId={job.id} group={selected} onSaved={refresh} /> : <div className="flex min-h-80 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">No candidates match this filter.</div>}</CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4"><div><CardTitle>Rapid RGB map and calibrated LiDAR</CardTitle><CardDescription><strong>Flat Map positions are approximate.</strong> Accepted coordinates and heights use CLC → CLI/pose → LiDAR, never Flat Map coordinates.</CardDescription></div><div className="flex shrink-0 flex-wrap gap-2"><Button onClick={() => enqueue('build_flat_map')} disabled={queueing != null || summary.accepted === 0} variant="outline"><Layers3 className="mr-2 h-4 w-4" />Build rapid map</Button><Button onClick={() => enqueue('map_lidar')} disabled={queueing != null || summary.accepted === 0}><MapPinned className="mr-2 h-4 w-4" />Map LiDAR</Button></div></CardHeader>
              <CardContent><RapidMap flatMapResult={job.flatMapResult} crowns={job.acceptedCrowns} /></CardContent>
            </Card>
          </div>

          <aside className="space-y-6">
            <Card><CardHeader><CardTitle>Job progress</CardTitle></CardHeader><CardContent className="space-y-3"><div className="h-2 overflow-hidden rounded-full bg-gray-200"><div className="h-full bg-emerald-600" style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></div><div className="flex justify-between text-sm"><span>{job.progress}%</span><span>{job.stage.replaceAll('_', ' ')}</span></div><Button variant="outline" className="w-full" onClick={refresh}><RotateCcw className="mr-2 h-4 w-4" />Refresh / resume</Button></CardContent></Card>
            <Card><CardHeader><CardTitle>Exception queues</CardTitle></CardHeader><CardContent className="space-y-3"><Exception label="Edge-clipped crowns" value={job.acceptedCrowns.filter((crown) => crown.edgeClipped).length} /><Exception label="Missing LiDAR" value={summary.missingLidar} /><Exception label="Unsure crowns" value={summary.unsure} /><Exception label="New cluster review" value={job.acceptedCrowns.filter((crown) => crown.lidarAssociation?.missingReason === 'new_cluster_requires_review').length} /></CardContent></Card>
            <Card><CardHeader><CardTitle>Exports</CardTitle><CardDescription>Exports reproduce deduplicated stored stock, observation lineage and explicit missing-height reasons.</CardDescription></CardHeader><CardContent className="space-y-2">{job.acceptedCrowns.every((crown) => crown.lidarAssociation) ? <><Button asChild variant="outline" className="w-full"><a href={`/api/pine-stocktake/jobs/${job.id}/export?format=csv`}><Download className="mr-2 h-4 w-4" />CSV</a></Button><Button asChild variant="outline" className="w-full"><a href={`/api/pine-stocktake/jobs/${job.id}/export?format=geojson`}><Download className="mr-2 h-4 w-4" />GeoJSON</a></Button></> : <p className="text-sm text-muted-foreground">Exports unlock after every accepted crown has a LiDAR result or explicit missing reason.</p>}</CardContent></Card>
            <Card><CardHeader><CardTitle>Audit trail</CardTitle></CardHeader><CardContent className="space-y-2 text-xs"><Audit label="Manifest" value={job.immutableManifestSha256} /><Audit label="Model weights" value={job.modelWeightSha256} /><Audit label="Runner commit" value={job.runnerCommit ?? 'Not recorded'} /><Audit label="Runner tree SHA-256" value={job.runnerTreeSha256 ?? 'Not recorded'} /><div className="flex items-start gap-2 pt-2 text-muted-foreground"><GitBranch className="mt-0.5 h-4 w-4 shrink-0" />Model predictions remain immutable. Every accepted crown points to a separate review revision.</div></CardContent></Card>
          </aside>
        </div>
      </div>
    </main>
  );
}

function CrownEditor({ jobId, group, onSaved }: { jobId: string; group: AgreementGroup; onSaved: () => Promise<void> }) {
  const representative = group.members[0].candidate;
  const width = representative.targetAsset.imageWidth ?? 6144;
  const height = representative.targetAsset.imageHeight ?? 4096;
  const [polygon, setPolygon] = useState<Point[]>(group.nativePolygon);
  const [edgeClipped, setEdgeClipped] = useState(false);
  const [mode, setMode] = useState<'adjust' | 'add_missed'>('adjust');
  const [saving, setSaving] = useState(false);
  const [dragging, setDragging] = useState<number | null>(null);
  const [parentRevisionId, setParentRevisionId] = useState<string | null>(null);
  useEffect(() => { setPolygon(group.nativePolygon); setMode('adjust'); setEdgeClipped(false); setParentRevisionId(null); }, [group]);

  const save = async (action: 'accept' | 'delete' | 'mark_unsure' | 'mark_edge_clipped') => {
    setSaving(true);
    try {
      const revisionId = crypto.randomUUID();
      const response = await fetch(`/api/pine-stocktake/jobs/${jobId}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ revisionId, candidateId: mode === 'add_missed' ? null : representative.id, parentRevisionId, sourceAssetId: representative.targetAssetId, sourceImageSha256: representative.targetImageSha256, nativePolygon: polygon, action, reviewState: action === 'accept' ? 'accepted' : action === 'delete' ? 'rejected' : action === 'mark_unsure' ? 'unsure' : 'working', edgeClipped: edgeClipped || action === 'mark_edge_clipped', crownId: action === 'accept' ? `${representative.targetAsset.fileName.replace(/\.[^.]+$/, '')}-${mode === 'add_missed' ? `M-${revisionId.slice(0, 8)}` : group.agreementId}` : undefined }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to save crown review');
      setParentRevisionId(data.revision.id);
      if (action === 'mark_edge_clipped') setEdgeClipped(true);
      else await onSaved();
    } finally { setSaving(false); }
  };

  const addPoint = (event: React.PointerEvent<SVGSVGElement>) => {
    if (mode !== 'add_missed' || dragging != null) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPolygon((current) => [...current, [((event.clientX - bounds.left) / bounds.width) * width, ((event.clientY - bounds.top) / bounds.height) * height]]);
  };

  const movePoint = (event: React.PointerEvent<SVGSVGElement>) => {
    if (dragging == null) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const point: Point = [Math.max(0, Math.min(width - 1, ((event.clientX - bounds.left) / bounds.width) * width)), Math.max(0, Math.min(height - 1, ((event.clientY - bounds.top) / bounds.height) * height))];
    setPolygon((current) => current.map((item, index) => index === dragging ? point : item));
  };

  return <div className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div><div className="font-medium">{representative.targetAsset.fileName}</div><div className="text-xs text-muted-foreground">Compare {group.members.length} independent exemplar result{group.members.length === 1 ? '' : 's'} · agreement {group.agreementLevel}/3</div></div><Button variant="outline" size="sm" onClick={() => { setMode('add_missed'); setPolygon([]); setParentRevisionId(null); setEdgeClipped(false); }}>Add missed crown</Button></div><div className="overflow-hidden rounded-md border bg-gray-900"><svg role="img" aria-label="Native image crown polygon editor" viewBox={`0 0 ${width} ${height}`} className="block aspect-[3/2] w-full touch-none" onPointerDown={addPoint} onPointerMove={movePoint} onPointerUp={() => setDragging(null)} onPointerLeave={() => setDragging(null)}><image href={representative.targetAsset.thumbnailUrl ?? representative.targetAsset.storageUrl} width={width} height={height} preserveAspectRatio="xMidYMid meet" />{group.members.map((member, index) => <polygon key={member.candidateId} points={(member.candidate.nativePolygon as Point[]).map((point) => point.join(',')).join(' ')} fill="none" stroke={['#f59e0b', '#0ea5e9', '#8b5cf6'][index]} strokeWidth="12" opacity="0.7" />)}{polygon.length > 1 && <polygon points={polygon.map((point) => point.join(',')).join(' ')} fill="rgba(34,197,94,.15)" stroke="#22c55e" strokeWidth="16" />}{polygon.map((point, index) => <circle key={`${point[0]}-${point[1]}-${index}`} cx={point[0]} cy={point[1]} r="28" fill="#fff" stroke="#16a34a" strokeWidth="10" onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); setDragging(index); }} />)}</svg></div><div className="flex flex-wrap gap-2"><Button size="sm" onClick={() => save('accept')} disabled={saving || polygon.length < 3}><Save className="mr-2 h-4 w-4" />Accept</Button><Button size="sm" variant="outline" onClick={() => save('mark_unsure')} disabled={saving}><CircleHelp className="mr-2 h-4 w-4" />Unsure</Button><Button size="sm" variant="outline" onClick={() => { setEdgeClipped(true); void save('mark_edge_clipped'); }} disabled={saving}>Edge clipped</Button><Button size="sm" variant="destructive" onClick={() => save('delete')} disabled={saving}><Trash2 className="mr-2 h-4 w-4" />Delete</Button></div><p className="text-xs text-muted-foreground">Drag vertices to adjust a crown. Click the image to add vertices for a missed crown. Saved revisions do not change immutable model polygons.</p></div>;
}

type ExemplarAsset = { id: string; fileName: string; storageUrl: string; thumbnailUrl: string | null; imageWidth: number | null; imageHeight: number | null };

function PineExemplarSelector({ jobId, projectId, targetAssetIds, onSaved }: { jobId: string; projectId: string; targetAssetIds: string[]; onSaved: () => Promise<void> }) {
  const [assets, setAssets] = useState<ExemplarAsset[]>([]);
  const [assetId, setAssetId] = useState('');
  const [sourceSha256, setSourceSha256] = useState('');
  const [polygon, setPolygon] = useState<Point[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void fetch(`/api/assets?projectId=${encodeURIComponent(projectId)}&limit=2000`).then((response) => response.json()).then((data) => {
      setAssets((data.assets ?? []).filter((asset: ExemplarAsset) => asset.imageWidth && asset.imageHeight && !targetAssetIds.includes(asset.id)));
    }).catch(() => setError('Could not load external exemplar images'));
  }, [projectId, targetAssetIds]);
  const asset = assets.find((item) => item.id === assetId);
  const addPoint = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!asset?.imageWidth || !asset.imageHeight) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    setPolygon((current) => [...current, [((event.clientX - bounds.left) / bounds.width) * asset.imageWidth!, ((event.clientY - bounds.top) / bounds.height) * asset.imageHeight!]]);
  };
  const approve = async () => {
    if (!asset || polygon.length < 3) return;
    setSaving(true); setError(null);
    try {
      const response = await fetch(`/api/pine-stocktake/jobs/${jobId}/exemplars`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceAssetId: asset.id, sourceImageSha256: sourceSha256, nativePolygon: polygon, approved: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Could not approve exemplar');
      setAssetId(''); setSourceSha256(''); setPolygon([]); await onSaved();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not approve exemplar'); }
    finally { setSaving(false); }
  };
  return <div className="rounded-lg border border-dashed p-4"><div className="mb-3"><div className="font-medium">Approve external exemplar</div><p className="text-xs text-muted-foreground">Select a non-target project image, enter its verified SHA-256, then click around one complete crown.</p></div><div className="grid gap-4 lg:grid-cols-[280px_1fr]"><div className="space-y-3"><div><Label htmlFor="exemplar-asset">Source image</Label><Select value={assetId} onValueChange={(value) => { setAssetId(value); setPolygon([]); }}><SelectTrigger id="exemplar-asset"><SelectValue placeholder="Select external image" /></SelectTrigger><SelectContent>{assets.map((item) => <SelectItem key={item.id} value={item.id}>{item.fileName}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="exemplar-sha">Image SHA-256</Label><Input id="exemplar-sha" value={sourceSha256} onChange={(event) => setSourceSha256(event.target.value.trim().toLowerCase())} placeholder="64 lowercase hex characters" spellCheck={false} /></div><div className="flex gap-2"><Button type="button" size="sm" variant="outline" disabled={!polygon.length} onClick={() => setPolygon((current) => current.slice(0, -1))}>Undo point</Button><Button type="button" size="sm" variant="outline" disabled={!polygon.length} onClick={() => setPolygon([])}>Clear</Button></div><Button type="button" onClick={approve} disabled={saving || polygon.length < 3 || !/^[a-f0-9]{64}$/.test(sourceSha256)}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Check className="mr-2 h-4 w-4" />}Approve exemplar</Button>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}</div>{asset?.imageWidth && asset.imageHeight ? <div className="overflow-hidden rounded-md border bg-gray-900"><svg role="img" aria-label="Draw one complete external exemplar crown" viewBox={`0 0 ${asset.imageWidth} ${asset.imageHeight}`} className="block aspect-[3/2] w-full cursor-crosshair" onPointerDown={addPoint}><image href={asset.thumbnailUrl ?? asset.storageUrl} width={asset.imageWidth} height={asset.imageHeight} preserveAspectRatio="xMidYMid meet" />{polygon.length > 1 && <polygon points={polygon.map((point) => point.join(',')).join(' ')} fill="rgba(16,185,129,.18)" stroke="#10b981" strokeWidth="16" />}{polygon.map((point, index) => <circle key={`${point[0]}-${point[1]}-${index}`} cx={point[0]} cy={point[1]} r="24" fill="#fff" stroke="#10b981" strokeWidth="10" />)}</svg></div> : <div className="flex min-h-72 items-center justify-center rounded-md border bg-gray-50 text-sm text-muted-foreground">Select an external source image.</div>}</div></div>;
}

function RapidMap({ flatMapResult, crowns }: { flatMapResult: Payload['job']['flatMapResult']; crowns: AcceptedCrownRow[] }) {
  const bounds = flatMapResult?.outputs.previewBounds;
  const preview = flatMapResult?.outputs.previewPng;
  const width = 1000;
  const height = 650;
  const project = (x: number, y: number): Point => {
    if (!bounds) return [0, 0];
    return [((x - bounds[0]) / (bounds[2] - bounds[0])) * width, height - ((y - bounds[1]) / (bounds[3] - bounds[1])) * height];
  };
  const mapped = crowns.filter((crown) => crown.lidarAssociation?.status === 'matched' && crown.lidarAssociation.x != null && crown.lidarAssociation.y != null);
  return <div className="space-y-3"><div className="overflow-hidden rounded-lg border bg-gray-100">{preview && bounds ? <svg role="img" aria-label="Approximate rapid RGB map with calibrated accepted crown overlay" viewBox={`0 0 ${width} ${height}`} className="block aspect-[20/13] w-full"><image href={preview.url} width={width} height={height} preserveAspectRatio="none" />{mapped.map((crown) => { const association = crown.lidarAssociation!; const centre = project(association.x!, association.y!); const apex = association.apexX != null && association.apexY != null ? project(association.apexX, association.apexY) : centre; const visible = centre[0] >= 0 && centre[0] <= width && centre[1] >= 0 && centre[1] <= height; return visible ? <g key={crown.id}><line x1={centre[0]} y1={centre[1]} x2={apex[0]} y2={apex[1]} stroke="white" strokeWidth="3" /><circle cx={centre[0]} cy={centre[1]} r="9" fill="#2563eb" stroke="white" strokeWidth="3" /><circle cx={apex[0]} cy={apex[1]} r="6" fill="#dc2626" stroke="white" strokeWidth="2" /><text x={centre[0] + 12} y={centre[1] - 8} fill="white" stroke="black" strokeWidth="3" paintOrder="stroke" fontSize="18">{association.heightP99M?.toFixed(2) ?? 'missing'} m</text></g> : null; })}</svg> : <div className="flex min-h-80 items-center justify-center bg-[linear-gradient(135deg,#e8f1e4_25%,#d7e7d1_25%,#d7e7d1_50%,#e8f1e4_50%,#e8f1e4_75%,#d7e7d1_75%)] bg-[length:32px_32px] text-sm text-muted-foreground">Build the rapid map to load the hashed PNG preview and projected bounds.</div>}</div><div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs"><div className="flex items-center gap-2 font-medium"><span className="h-3 w-3 rounded-full bg-blue-600" />LiDAR crown location</div><div className="flex items-center gap-2 font-medium"><span className="h-3 w-3 rounded-full bg-red-600" />Highest valid crown point</div><div className="rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-950">Rapid imagery is approximate; blue and red points use calibrated LiDAR coordinates.</div>{flatMapResult?.outputs.browserViewer?.url && <a href={flatMapResult.outputs.browserViewer.url} target="_blank" rel="noreferrer" className="font-medium text-emerald-700 underline">Open hashed browser viewer</a>}</div></div>;
}

function Identity({ label, value, detail }: { label: string; value: string; detail: string }) { return <div className="rounded-md border bg-gray-50 p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div><div className="mt-1 break-all font-mono text-[10px] text-muted-foreground">{detail}</div></div>; }
function Exception({ label, value }: { label: string; value: number }) { return <div className="flex items-center justify-between rounded-md border px-3 py-2 text-sm"><span>{label}</span><Badge variant={value ? 'destructive' : 'secondary'}>{value}</Badge></div>; }
function Audit({ label, value }: { label: string; value: string }) { return <div><div className="text-muted-foreground">{label}</div><div className="break-all font-mono">{value}</div></div>; }
