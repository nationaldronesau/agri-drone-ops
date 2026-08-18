'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, FileCheck2, Loader2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

type Project = { id: string; name: string; location: string | null };
type MissionManifest = { latitude: number; longitude: number; poseTimebase: string; files: { kind: string; assetId?: string; fileName: string; sha256: string; cameraSerial?: string; poseIdentity?: string; timebase?: string; crs?: string; metadata?: Record<string, unknown> }[] };

export function PineMissionSetup({ orthomosaicId }: { orthomosaicId?: string }) {
  const router = useRouter();
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState('');
  const [manifest, setManifest] = useState<MissionManifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => { void fetch('/api/projects').then((response) => response.json()).then((data) => setProjects(data.projects ?? [])).catch(() => setError('Failed to load projects')); }, []);

  const readManifest = async (file: File) => {
    setError(null);
    try {
      const parsed = JSON.parse(await file.text()) as MissionManifest;
      if (!Array.isArray(parsed.files) || !parsed.files.length) throw new Error('Manifest contains no mission files');
      setManifest(parsed);
    } catch (cause) { setManifest(null); setError(cause instanceof Error ? cause.message : 'Invalid mission manifest'); }
  };

  const create = async () => {
    if (!manifest || !projectId) return;
    setSubmitting(true); setError(null);
    try {
      const response = await fetch('/api/pine-stocktake/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId, orthomosaicId, ...manifest }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Mission validation failed');
      router.push(`/orthomosaics/pine-stocktake/${data.jobId}`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to create Pine Stocktake'); }
    finally { setSubmitting(false); }
  };

  return <main className="min-h-screen bg-gray-50"><header className="bg-gradient-to-r from-emerald-700 to-sky-700 text-white"><div className="container mx-auto px-4 py-8"><p className="text-sm text-emerald-100">Pine Stocktake · Stage 1 of 4</p><h1 className="mt-2 text-3xl font-semibold">Upload and validate mission</h1><p className="mt-2 max-w-3xl text-emerald-100">Associate native LV/RV images, flight-specific CLC and CLI calibration, pose records, LiDAR and file hashes. Precise mapping remains blocked until every identity passes.</p></div></header><div className="container mx-auto grid gap-6 p-6 lg:grid-cols-[1fr_360px]"><Card><CardHeader><CardTitle>Mission association</CardTitle><CardDescription>Upload a JSON mission manifest that points to uploaded project assets and records SHA-256, camera serial, timebase and CRS identity.</CardDescription></CardHeader><CardContent className="space-y-5"><div><Label htmlFor="pine-project">Project</Label><Select value={projectId} onValueChange={setProjectId}><SelectTrigger id="pine-project"><SelectValue placeholder="Select project" /></SelectTrigger><SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}{project.location ? ` · ${project.location}` : ''}</SelectItem>)}</SelectContent></Select></div><div><Label htmlFor="mission-manifest">Mission manifest</Label><Input id="mission-manifest" type="file" accept="application/json,.json" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readManifest(file); }} /><p className="mt-1 text-xs text-muted-foreground">The manifest is immutable after job creation. Raw mission objects stay in project storage.</p></div>{error && <div role="alert" className="flex gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}{manifest && <div className="rounded-md border"><div className="flex items-center gap-2 border-b bg-emerald-50 p-3 text-sm font-medium text-emerald-900"><FileCheck2 className="h-4 w-4" />{manifest.files.length} files ready for validation</div><div className="max-h-64 overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th className="p-2">Type</th><th className="p-2">File</th><th className="p-2">Hash</th></tr></thead><tbody>{manifest.files.map((file, index) => <tr key={`${file.fileName}-${index}`} className="border-t"><td className="p-2">{file.kind}</td><td className="p-2">{file.fileName}</td><td className="p-2 font-mono text-xs">{file.sha256?.slice(0, 12)}…</td></tr>)}</tbody></table></div></div>}<Button onClick={create} disabled={!projectId || !manifest || submitting}>{submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <UploadCloud className="mr-2 h-4 w-4" />}Create restartable job</Button></CardContent></Card><aside className="space-y-4"><Card><CardHeader><CardTitle className="text-lg">Required identities</CardTitle></CardHeader><CardContent><ul className="space-y-2 text-sm"><li>Native LV and RV image hashes</li><li>Camera serial matching the CLC</li><li>CLI and CLC file hashes</li><li>MRK plus RPOS or equivalent pose identity</li><li>One proven pose timebase</li><li>LAS/LAZ hash and projected CRS</li></ul></CardContent></Card><Card className="border-amber-300 bg-amber-50"><CardContent className="pt-5 text-sm text-amber-950"><strong>No generic calibration.</strong> A serial mismatch, missing pose identity, ambiguous timebase or unknown CRS blocks precise mapping.</CardContent></Card></aside></div></main>;
}
