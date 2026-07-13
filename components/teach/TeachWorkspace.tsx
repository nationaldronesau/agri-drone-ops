"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  ArrowRight,
  Box,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Crosshair,
  Eye,
  ImageIcon,
  Leaf,
  Loader2,
  Maximize2,
  Search,
  ShieldCheck,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import { useSignedUrl } from "@/lib/hooks/useSignedUrl";

interface Project {
  id: string;
  name: string;
  _count?: { assets?: number };
}

interface Asset {
  id: string;
  fileName: string;
  storageUrl: string;
  imageWidth?: number | null;
  imageHeight?: number | null;
  objectPosition?: string;
}

interface ExemplarBox {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type DraftBox = Omit<ExemplarBox, "id">;

const DEMO_PROJECT: Project = {
  id: "demo-north-paddock",
  name: "North Paddock — Lantana",
  _count: { assets: 146 },
};

const DEMO_ASSETS: Asset[] = Array.from({ length: 12 }, (_, index) => ({
  id: `demo-asset-${index + 1}`,
  fileName: `North_Paddock_${String(index + 1).padStart(3, "0")}.jpg`,
  storageUrl: "/demo/lantana-batch-aerial.jpg",
  imageWidth: 1536,
  imageHeight: 1024,
  objectPosition: `${12 + ((index * 23) % 76)}% ${18 + ((index * 19) % 66)}%`,
}));

const STEPS = ["Upload", "Teach", "Review", "Train", "Detect", "Spray Plan", "Export"];

const GUIDE_ITEMS = [
  { icon: Maximize2, title: "Different sizes", body: "Pick small, medium, and large plants if they exist." },
  { icon: Sun, title: "Different lighting", body: "Include bright sun, shade, and low-light areas." },
  { icon: ImageIcon, title: "Different backgrounds", body: "Include soil, grass, shadows, and debris." },
  { icon: Leaf, title: "Different growth stages", body: "Include young, mature, and flowering plants." },
];

function Thumbnail({ asset, active, demo, onSelect }: { asset: Asset; active: boolean; demo: boolean; onSelect: () => void }) {
  const signed = useSignedUrl(demo ? null : asset.id, "asset", asset.storageUrl);
  const src = demo ? asset.storageUrl : signed.url || asset.storageUrl;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={`Use ${asset.fileName} as the source image`}
      aria-current={active ? "true" : undefined}
      className={`relative h-[74px] w-[100px] flex-none overflow-hidden rounded-lg border-2 bg-gray-100 transition focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 ${active ? "border-blue-500 shadow-sm" : "border-transparent hover:border-gray-300"}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        className={`h-full w-full object-cover ${demo ? "scale-[2.35]" : ""}`}
        style={{ objectPosition: asset.objectPosition || "center", transformOrigin: asset.objectPosition || "center" }}
      />
      <span className={`absolute left-1.5 top-1.5 h-2.5 w-2.5 rounded-full border border-white ${active ? "bg-blue-500" : "bg-emerald-500"}`} />
    </button>
  );
}

export default function TeachWorkspace() {
  const searchParams = useSearchParams();
  const demo = process.env.NODE_ENV !== "production" && searchParams.get("demo") === "1";
  const [projects, setProjects] = useState<Project[]>(demo ? [DEMO_PROJECT] : []);
  const [projectId, setProjectId] = useState(demo ? DEMO_PROJECT.id : "");
  const [assets, setAssets] = useState<Asset[]>(demo ? DEMO_ASSETS : []);
  const [assetId, setAssetId] = useState(demo ? DEMO_ASSETS[5].id : "");
  const [target, setTarget] = useState("Lantana");
  const [targetDraft, setTargetDraft] = useState("Lantana");
  const [editingTarget, setEditingTarget] = useState(false);
  const [guideOpen, setGuideOpen] = useState(true);
  const [loadingProjects, setLoadingProjects] = useState(!demo);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [boxes, setBoxes] = useState<ExemplarBox[]>([]);
  const [draft, setDraft] = useState<DraftBox | null>(null);
  const [keyboardCursor, setKeyboardCursor] = useState({ x: 768, y: 512 });
  const [keyboardActive, setKeyboardActive] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 1536, height: 1024 });
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [filter, setFilter] = useState("");
  const imageRef = useRef<HTMLDivElement>(null);

  const project = projects.find((item) => item.id === projectId) || projects[0] || null;
  const asset = assets.find((item) => item.id === assetId) || assets[0] || null;
  const signedMain = useSignedUrl(demo ? null : asset?.id || null, "asset", asset?.storageUrl);
  const mainImage = demo ? asset?.storageUrl : signedMain.url || asset?.storageUrl;
  const batchCount = demo ? 146 : assets.length;
  const visibleAssets = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return query ? assets.filter((item, index) => item.fileName.toLowerCase().includes(query) || String(index + 1).includes(query)) : assets;
  }, [assets, filter]);
  const coverTransform = useMemo(() => {
    const scale = Math.max(frameSize.width / imageSize.width, frameSize.height / imageSize.height);
    return {
      scale,
      cropX: (imageSize.width * scale - frameSize.width) / 2,
      cropY: (imageSize.height * scale - frameSize.height) / 2,
    };
  }, [frameSize, imageSize]);

  useEffect(() => {
    if (demo) return;
    let cancelled = false;
    async function loadProjects() {
      setLoadingProjects(true);
      try {
        const response = await fetch("/api/projects?pageSize=200");
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in to choose a project." : "Projects could not be loaded.");
        const data = await response.json();
        if (cancelled) return;
        const nextProjects: Project[] = data.projects || [];
        const requested = searchParams.get("projectId");
        setProjects(nextProjects);
        setProjectId(nextProjects.some((item) => item.id === requested) ? requested || "" : nextProjects[0]?.id || "");
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Projects could not be loaded.");
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    }
    loadProjects();
    return () => { cancelled = true; };
  }, [demo, searchParams]);

  useEffect(() => {
    if (demo || !projectId) return;
    let cancelled = false;
    async function loadAssets() {
      setLoadingAssets(true);
      try {
        const response = await fetch(`/api/assets?projectId=${projectId}&limit=200`);
        if (!response.ok) throw new Error("Images for this project could not be loaded.");
        const data = await response.json();
        if (cancelled) return;
        const nextAssets: Asset[] = data.assets || [];
        setAssets(nextAssets);
        setAssetId(nextAssets[0]?.id || "");
        setBoxes([]);
      } catch (loadError) {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : "Images could not be loaded.");
      } finally {
        if (!cancelled) setLoadingAssets(false);
      }
    }
    loadAssets();
    return () => { cancelled = true; };
  }, [demo, projectId]);

  useEffect(() => {
    const frame = imageRef.current;
    if (!frame) return;
    const update = () => setFrameSize({ width: frame.clientWidth || 1, height: frame.clientHeight || 1 });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [mainImage]);

  function eventPoint(event: React.PointerEvent<HTMLDivElement>) {
    const frame = imageRef.current;
    if (!frame) return null;
    const rect = frame.getBoundingClientRect();
    const displayX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
    const displayY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
    return {
      x: Math.max(0, Math.min(imageSize.width, (displayX + coverTransform.cropX) / coverTransform.scale)),
      y: Math.max(0, Math.min(imageSize.height, (displayY + coverTransform.cropY) / coverTransform.scale)),
    };
  }

  function beginBox(event: React.PointerEvent<HTMLDivElement>) {
    if (boxes.length >= 8) return;
    const point = eventPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft({ x1: point.x, y1: point.y, x2: point.x, y2: point.y });
    setNotice(null);
  }

  function moveBox(event: React.PointerEvent<HTMLDivElement>) {
    if (!draft) return;
    const point = eventPoint(event);
    if (point) setDraft((current) => current ? { ...current, x2: point.x, y2: point.y } : null);
  }

  function commitDraft(candidate: DraftBox) {
    if (Math.abs(candidate.x2 - candidate.x1) <= imageSize.width * 0.015 || Math.abs(candidate.y2 - candidate.y1) <= imageSize.height * 0.015) return;
    setBoxes((current) => [...current, {
      id: crypto.randomUUID(),
      x1: Math.min(candidate.x1, candidate.x2), y1: Math.min(candidate.y1, candidate.y2),
      x2: Math.max(candidate.x1, candidate.x2), y2: Math.max(candidate.y1, candidate.y2),
    }]);
  }

  function finishBox(event: React.PointerEvent<HTMLDivElement>) {
    if (!draft) return;
    commitDraft(draft);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDraft(null);
  }

  function handleCanvasKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter", "Escape"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "Escape") {
      setDraft(null);
      return;
    }
    if (event.key === "Enter") {
      if (draft) {
        commitDraft(draft);
        setDraft(null);
      } else if (boxes.length < 8) {
        setDraft({ x1: keyboardCursor.x, y1: keyboardCursor.y, x2: keyboardCursor.x, y2: keyboardCursor.y });
      }
      return;
    }
    const stepX = imageSize.width / 40;
    const stepY = imageSize.height / 40;
    const next = {
      x: Math.max(0, Math.min(imageSize.width, keyboardCursor.x + (event.key === "ArrowLeft" ? -stepX : event.key === "ArrowRight" ? stepX : 0))),
      y: Math.max(0, Math.min(imageSize.height, keyboardCursor.y + (event.key === "ArrowUp" ? -stepY : event.key === "ArrowDown" ? stepY : 0))),
    };
    setKeyboardCursor(next);
    setDraft((current) => current ? { ...current, x2: next.x, y2: next.y } : null);
  }

  function selectAsset(nextAsset: Asset) {
    if (nextAsset.id === assetId) return;
    if (boxes.length && !window.confirm("Choose a different source image? Your current example boxes will be cleared.")) return;
    setAssetId(nextAsset.id);
    setBoxes([]);
    setNotice("New source image selected. Mark 3–8 examples on this image.");
  }

  function styleBox(box: DraftBox | ExemplarBox) {
    const left = Math.min(box.x1, box.x2) * coverTransform.scale - coverTransform.cropX;
    const top = Math.min(box.y1, box.y2) * coverTransform.scale - coverTransform.cropY;
    return {
      left: `${(left / frameSize.width) * 100}%`,
      top: `${(top / frameSize.height) * 100}%`,
      width: `${(Math.abs(box.x2 - box.x1) * coverTransform.scale / frameSize.width) * 100}%`,
      height: `${(Math.abs(box.y2 - box.y1) * coverTransform.scale / frameSize.height) * 100}%`,
    };
  }

  function stylePoint(point: { x: number; y: number }) {
    return {
      left: `${((point.x * coverTransform.scale - coverTransform.cropX) / frameSize.width) * 100}%`,
      top: `${((point.y * coverTransform.scale - coverTransform.cropY) / frameSize.height) * 100}%`,
    };
  }

  async function searchBatch() {
    if (!project || !asset || boxes.length < 3) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    if (demo) {
      await new Promise((resolve) => window.setTimeout(resolve, 650));
      setSubmitting(false);
      setNotice("Demo batch queued. In a signed-in project, every suggestion will wait in Review.");
      return;
    }
    try {
      const response = await fetch("/api/sam3/v2/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          weedType: target,
          mode: "concept_propagation",
          exemplars: boxes.map(({ x1, y1, x2, y2 }) => ({ x1, y1, x2, y2 })),
          exemplarSourceWidth: imageSize.width,
          exemplarSourceHeight: imageSize.height,
          sourceAssetId: asset.id,
          assetIds: assets.slice(0, 200).map((item) => item.id),
          textPrompt: target,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "The search could not be started.");
      setNotice(`Search started across ${assets.length} images. Every suggestion will wait in Review.`);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "The search could not be started.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!demo && !loadingProjects && !error && projects.length === 0) {
    return <div className="flex min-h-screen items-center justify-center p-8"><div className="max-w-md text-center"><Box className="mx-auto mb-4 h-10 w-10 text-emerald-600" /><h1 className="text-2xl font-semibold">Create a project to start teaching</h1><p className="mt-2 text-sm text-gray-600">Projects keep imagery, labels, models, and spray outputs together.</p><Link href="/projects" className="mt-6 inline-flex rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white">Open projects</Link></div></div>;
  }

  return (
    <div className="flex min-h-screen flex-col bg-white text-gray-950">
      <header className="flex min-h-[72px] items-center justify-between border-b border-gray-200 px-3 sm:px-5 lg:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-emerald-50 text-emerald-600"><Box className="h-5 w-5" /></span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <select aria-label="Project" value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={demo || loadingProjects} className="max-w-[190px] truncate bg-transparent text-base font-semibold outline-none disabled:opacity-100 sm:max-w-[420px] sm:text-lg">
                {projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </div>
            <p className="text-sm text-gray-500">{batchCount || project?._count?.assets || 0} images in this batch</p>
          </div>
        </div>
        <Link href="/projects" className="hidden items-center gap-2 rounded-lg border border-gray-200 px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 sm:inline-flex">Project actions <ChevronDown className="h-4 w-4" /></Link>
      </header>

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[170px_minmax(0,1fr)]">
        <aside className="hidden border-r border-gray-200 px-5 py-6 lg:block">
          <ol>{STEPS.map((step, index) => {
            const complete = index === 0;
            const active = index === 1;
            return <li key={step} className="relative flex min-h-[82px] gap-3">
              {index < STEPS.length - 1 && <span className={`absolute left-[11px] top-7 h-[55px] w-px ${complete ? "bg-emerald-400" : "bg-gray-200"}`} />}
              <span className={`relative z-10 flex h-6 w-6 flex-none items-center justify-center rounded-full border text-xs font-semibold ${complete ? "border-emerald-500 bg-emerald-500 text-white" : active ? "border-blue-500 bg-blue-500 text-white" : "border-gray-300 bg-white text-gray-500"}`}>{complete ? <Check className="h-3.5 w-3.5" /> : index + 1}</span>
              <div><p className="text-sm font-semibold">{step}</p><p className={`mt-0.5 text-xs ${active ? "text-blue-600" : "text-gray-500"}`}>{complete ? "Complete" : active ? "In progress" : "Not started"}</p></div>
            </li>;
          })}</ol>
        </aside>

        <main className="flex min-w-0 flex-col bg-gray-50/60">
          <section className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-200 bg-white px-5 py-3.5 lg:px-7">
            <div>
              <h1 className="text-xl font-semibold tracking-tight">What should we find?</h1>
              {editingTarget ? <div className="mt-2 flex gap-2"><input autoFocus aria-label="Target name" value={targetDraft} onChange={(event) => setTargetDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && targetDraft.trim()) { setTarget(targetDraft.trim()); setEditingTarget(false); } }} className="h-10 w-64 rounded-lg border border-gray-300 px-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /><button type="button" onClick={() => { if (targetDraft.trim()) { setTarget(targetDraft.trim()); setEditingTarget(false); } }} className="rounded-lg bg-gray-950 px-3 text-sm font-medium text-white">Save</button></div> : <div className="mt-2 inline-flex items-center gap-3 rounded-lg border border-gray-200 bg-white px-2.5 py-2"><span className="h-8 w-8 overflow-hidden rounded-md bg-emerald-50">{mainImage ? <img src={mainImage} alt="" className="h-full w-full scale-150 object-cover" /> : <Leaf className="m-2 h-4 w-4 text-emerald-600" />}</span><span className="font-semibold">{target}</span><button type="button" onClick={() => setEditingTarget(true)} className="ml-4 text-sm font-medium text-blue-600">Change target</button></div>}
            </div>
            <button type="button" onClick={() => setGuideOpen((open) => !open)} aria-expanded={guideOpen} className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"><CircleHelp className="h-4 w-4" /> How to mark examples <ChevronDown className={`h-4 w-4 transition ${guideOpen ? "rotate-180" : ""}`} /></button>
          </section>

          {error && <div className="mx-5 mt-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 lg:mx-7">{error}</div>}
          {notice && <div className="mx-5 mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 lg:mx-7">{notice}</div>}

          <section className="relative mx-5 mt-3 flex min-h-[410px] flex-1 items-center justify-center overflow-hidden rounded-xl border border-gray-200 bg-gray-900 lg:mx-7">
            {loadingAssets || signedMain.loading ? <div className="flex items-center text-white"><Loader2 className="mr-2 h-5 w-5 animate-spin" />Loading image…</div> : !asset || !mainImage ? <div className="text-center text-white"><ImageIcon className="mx-auto mb-3 h-9 w-9 text-gray-400" /><p className="font-medium">This project has no images yet.</p><Link href="/upload" className="mt-3 inline-block text-sm text-emerald-300 underline">Upload images</Link></div> : <div
              ref={imageRef}
              data-testid="teach-image-canvas"
              role="region"
              tabIndex={0}
              aria-label="Example marking canvas"
              aria-describedby="teach-canvas-instructions"
              className="relative h-full min-h-[410px] w-full touch-none select-none cursor-crosshair overflow-hidden"
              onPointerDown={beginBox}
              onPointerMove={moveBox}
              onPointerUp={finishBox}
              onPointerCancel={() => setDraft(null)}
              onKeyDown={handleCanvasKeyDown}
              onFocus={() => setKeyboardActive(true)}
              onBlur={() => setKeyboardActive(false)}
            >
              <p id="teach-canvas-instructions" className="sr-only">Use the arrow keys to move the cursor. Press Enter to start a box, move to its opposite corner, then press Enter again to add the example. Press Escape to cancel.</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={mainImage} alt={`${project?.name || "Project"} source imagery`} className="absolute inset-0 h-full w-full object-cover" onLoad={(event) => { const size = { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }; setImageSize(size); setKeyboardCursor({ x: size.width / 2, y: size.height / 2 }); }} draggable={false} />
              <div className="absolute left-3 top-3 max-w-[340px] rounded-lg bg-gray-950/90 px-4 py-3 text-white shadow-lg backdrop-blur-sm"><p className="font-semibold">Mark 3–8 examples that look different</p><p className="mt-1 text-sm leading-5 text-gray-300">Choose plants that vary in size, colour, lighting, and background.</p><p className="mt-2 text-sm"><span className="font-semibold text-emerald-300">{boxes.length}</span> of 3–8 examples marked</p><div className="mt-2 flex gap-1.5">{Array.from({ length: 8 }, (_, index) => <span key={index} className={`h-1.5 flex-1 rounded-full ${index < boxes.length ? "bg-emerald-400" : "bg-gray-600"}`} />)}</div></div>
              {boxes.map((box, index) => <div key={box.id} className="pointer-events-none absolute border-2 border-emerald-400 bg-emerald-400/10" style={styleBox(box)}><span className="absolute -left-0.5 -top-7 flex h-7 min-w-7 items-center justify-center rounded-t-md bg-emerald-500 px-1 text-xs font-bold text-white">{index + 1}</span><button type="button" aria-label={`Remove example ${index + 1}`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setBoxes((current) => current.filter((item) => item.id !== box.id)); }} className="pointer-events-auto absolute -right-3 -top-3 flex h-7 w-7 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-700 shadow"><X className="h-3.5 w-3.5" /></button></div>)}
              {draft && <div className="pointer-events-none absolute border-2 border-dashed border-emerald-300 bg-emerald-300/10" style={styleBox(draft)} />}
              {keyboardActive && <Crosshair className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-1/2 text-white drop-shadow" style={stylePoint(keyboardCursor)} aria-hidden="true" />}
              {guideOpen && <aside className="absolute bottom-3 right-3 top-3 w-[270px] overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 shadow-xl"><div className="flex items-center justify-between"><h2 className="font-semibold">How to mark good examples</h2><button type="button" aria-label="Close example guide" onClick={() => setGuideOpen(false)} className="rounded p-1 text-gray-500 hover:bg-gray-100"><X className="h-4 w-4" /></button></div><div className="mt-4 space-y-4">{GUIDE_ITEMS.map(({ icon: Icon, title, body }) => <div key={title} className="flex gap-3"><Icon className="mt-0.5 h-4 w-4 flex-none text-gray-600" /><div><p className="text-sm font-semibold">{title}</p><p className="mt-1 text-xs leading-5 text-gray-600">{body}</p></div></div>)}</div></aside>}
            </div>}
          </section>

          <section className="border-b border-gray-200 bg-white px-5 pb-3 pt-3 lg:px-7">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3"><div className="flex items-baseline gap-3"><h2 className="text-sm font-semibold">Batch images ({batchCount})</h2><p className="text-xs text-gray-500">Choose the best image, then mark all examples on it.</p></div><div className="flex items-center gap-2"><label className="relative hidden sm:block"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Jump to image…" className="h-9 w-56 rounded-lg border border-gray-200 pl-9 pr-3 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100" /></label><button type="button" aria-label="Previous images" className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200"><ChevronLeft className="h-4 w-4" /></button><button type="button" aria-label="Next images" className="flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200"><ChevronRight className="h-4 w-4" /></button></div></div>
            <div className="flex gap-2 overflow-x-auto pb-1">{visibleAssets.map((item) => <Thumbnail key={item.id} asset={item} active={item.id === assetId} demo={demo} onSelect={() => selectAsset(item)} />)}</div>
          </section>

          <footer className="sticky bottom-0 z-20 bg-white px-5 pb-3 pt-3 shadow-[0_-8px_30px_rgba(15,23,42,0.06)] lg:px-7">
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm text-amber-950"><ShieldCheck className="mt-0.5 h-4 w-4 flex-none text-amber-600" /><span><strong>Safety first:</strong> Matches are suggestions for review. They are never used for spraying automatically.</span></div>
            <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex w-full gap-2 sm:w-auto"><button type="button" onClick={() => setBoxes([])} disabled={!boxes.length} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 disabled:opacity-40 sm:flex-none sm:px-4"><Trash2 className="h-4 w-4" />Clear examples</button><Link href="/review-queue" className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 text-sm font-medium text-gray-700 sm:flex-none sm:px-4"><Eye className="h-4 w-4" />Open review</Link></div><button type="button" onClick={searchBatch} disabled={submitting || boxes.length < 3 || !asset} className="inline-flex h-12 w-full min-w-0 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-emerald-500 to-blue-500 px-4 text-sm font-semibold text-white shadow-sm hover:from-emerald-600 hover:to-blue-600 disabled:cursor-not-allowed disabled:from-gray-300 disabled:to-gray-300 sm:w-auto sm:min-w-[330px] sm:px-6">{submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}{submitting ? "Starting search…" : `Search this batch${batchCount ? ` (${batchCount})` : ""}`} {!submitting && <ArrowRight className="h-4 w-4" />}</button></div>
          </footer>
        </main>
      </div>
    </div>
  );
}
