import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { buildExemplarCropsFromDetections } from "@/lib/utils/exemplar-crops";

type StrategyName = "baseline" | "enhanced";
type ReplayTechnique = "crops" | "concept" | "both";
type CropSource = "operator" | "source-detections" | "both";

type Box = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
};

type Detection = {
  bbox: [number, number, number, number];
  confidence: number;
  className: string;
  similarity?: number;
  polygon?: [number, number][];
};

type FixtureImage = {
  id?: string;
  image: string;
};

type SourceFixture = FixtureImage & {
  boxes: Box[];
  exemplarCrops?: string[];
  exemplarCropFiles?: string[];
};

type ReplayFixture = {
  name?: string;
  className?: string;
  source: SourceFixture;
  targets: FixtureImage[];
};

type ParsedArgs = {
  fixturePath: string;
  outputDir: string;
  sam3Url: string | null;
  conceptUrl: string | null;
  conceptApiKey: string | null;
  dryRun: boolean;
  technique: ReplayTechnique;
  cropSource: CropSource;
  strategy: "both" | StrategyName;
  maxCrops: number;
  conceptMaxBoxes: number;
  maxImageSize: number;
  timeoutMs: number;
  minSize: number;
  minAnchorOverlap: number;
  sourceCropMinConfidence: number;
  sourceCropPadding: number;
  sourceCropMask: boolean;
  conceptSimilarityThreshold: number;
  conceptFallbackSimilarityThreshold: number;
  conceptTopK: number;
  conceptFallbackTopK: number;
  conceptMinBoxSize: number;
  conceptMaxBoxSize: number;
  conceptNmsThreshold: number;
  conceptMinCandidates: number;
  skipHealth: boolean;
};

type LoadedImage = {
  id: string;
  reference: string;
  buffer: Buffer;
  width: number;
  height: number;
};

type ScalingInfo = {
  originalWidth: number;
  originalHeight: number;
  scaledWidth: number;
  scaledHeight: number;
  scaleFactor: number;
};

type Sam3RunResult = {
  ok: boolean;
  detections: Detection[];
  count: number;
  error?: string;
  request: {
    endpoint: "/segment";
    mode: "boxes" | "exemplar_crops";
    cropCount?: number;
    boxCount?: number;
    scaling: ScalingInfo;
  };
  rawResponse?: unknown;
};

type TargetManifest = {
  id: string;
  image: string;
  count: number;
  outcome: "success" | "zero_detections" | "error" | "dry_run";
  jsonPath: string;
  overlayPath: string;
  error?: string;
};

type StrategyManifest = {
  name: StrategyName;
  cropSource: CropSource;
  cropCount: number;
  cropFiles: string[];
  sourceBoxesUsed: Box[];
  targets: TargetManifest[];
};

type ConceptManifest = {
  exemplarId: string | null;
  sourceBoxesUsed: Box[];
  targets: Array<
    TargetManifest & {
      strictCandidateCount?: number;
      fallbackCandidateCount?: number;
      candidateCount?: number;
      refinedCount?: number;
    }
  >;
};

const DEFAULT_MAX_IMAGE_SIZE = 2048;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MIN_SIZE = 100;
const DEFAULT_MIN_ANCHOR_OVERLAP = 0.2;
const DEFAULT_SOURCE_CROP_MIN_CONFIDENCE = 0.6;
const DEFAULT_SOURCE_CROP_PADDING = 0.08;
const DEFAULT_CONCEPT_MAX_BOXES = 30;
const DEFAULT_CONCEPT_SIMILARITY_THRESHOLD = 0.65;
const DEFAULT_CONCEPT_FALLBACK_SIMILARITY_THRESHOLD = 0.5;
const DEFAULT_CONCEPT_TOP_K = 120;
const DEFAULT_CONCEPT_FALLBACK_TOP_K = 40;
const DEFAULT_CONCEPT_MIN_BOX_SIZE = 16;
const DEFAULT_CONCEPT_MAX_BOX_SIZE = 600;
const DEFAULT_CONCEPT_NMS_THRESHOLD = 0.5;
const DEFAULT_CONCEPT_MIN_CANDIDATES = 25;
const DATA_URL_PREFIX = /^data:image\/[a-zA-Z0-9.+-]+;base64,/;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith("--")) continue;

    const key = raw.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args.set(key, "true");
    } else {
      args.set(key, next);
      i += 1;
    }
  }

  const fixturePath = args.get("fixture");
  if (!fixturePath) {
    throw new Error(
      "Usage: npm run sam3:replay -- --fixture <fixture.json> [--sam3-url http://host:8000] [--out ./tmp/sam3-replay] [--dry-run]"
    );
  }

  const strategy = args.get("strategy") ?? "both";
  if (!["both", "baseline", "enhanced"].includes(strategy)) {
    throw new Error("--strategy must be one of: both, baseline, enhanced");
  }

  const technique = args.get("technique") ?? "crops";
  if (!["crops", "concept", "both"].includes(technique)) {
    throw new Error("--technique must be one of: crops, concept, both");
  }

  const cropSource = args.get("crop-source") ?? "both";
  if (!["operator", "source-detections", "both"].includes(cropSource)) {
    throw new Error("--crop-source must be one of: operator, source-detections, both");
  }

  const maxCrops = parsePositiveInt(args.get("max-crops"), 10, "--max-crops");
  const conceptMaxBoxes = parsePositiveInt(
    args.get("concept-max-boxes"),
    DEFAULT_CONCEPT_MAX_BOXES,
    "--concept-max-boxes"
  );
  const maxImageSize = parsePositiveInt(
    args.get("max-image-size"),
    DEFAULT_MAX_IMAGE_SIZE,
    "--max-image-size"
  );
  const timeoutMs = parsePositiveInt(args.get("timeout-ms"), DEFAULT_TIMEOUT_MS, "--timeout-ms");
  const minSize = parsePositiveInt(args.get("min-size"), DEFAULT_MIN_SIZE, "--min-size");
  const minAnchorOverlap = parseRatio(
    args.get("min-anchor-overlap"),
    DEFAULT_MIN_ANCHOR_OVERLAP,
    "--min-anchor-overlap"
  );
  const sourceCropMinConfidence = parseRatio(
    args.get("source-crop-min-confidence"),
    DEFAULT_SOURCE_CROP_MIN_CONFIDENCE,
    "--source-crop-min-confidence"
  );
  const sourceCropPadding = parseRatio(
    args.get("source-crop-padding"),
    DEFAULT_SOURCE_CROP_PADDING,
    "--source-crop-padding"
  );
  const sourceCropMask = parseBoolean(args.get("source-crop-mask"), true, "--source-crop-mask");
  const conceptSimilarityThreshold = parseRatio(
    args.get("concept-similarity-threshold"),
    DEFAULT_CONCEPT_SIMILARITY_THRESHOLD,
    "--concept-similarity-threshold"
  );
  const conceptFallbackSimilarityThreshold = parseRatio(
    args.get("concept-fallback-similarity-threshold"),
    DEFAULT_CONCEPT_FALLBACK_SIMILARITY_THRESHOLD,
    "--concept-fallback-similarity-threshold"
  );
  const conceptTopK = parsePositiveInt(args.get("concept-top-k"), DEFAULT_CONCEPT_TOP_K, "--concept-top-k");
  const conceptFallbackTopK = parsePositiveInt(
    args.get("concept-fallback-top-k"),
    DEFAULT_CONCEPT_FALLBACK_TOP_K,
    "--concept-fallback-top-k"
  );
  const conceptMinBoxSize = parsePositiveInt(
    args.get("concept-min-box-size"),
    DEFAULT_CONCEPT_MIN_BOX_SIZE,
    "--concept-min-box-size"
  );
  const conceptMaxBoxSize = parsePositiveInt(
    args.get("concept-max-box-size"),
    DEFAULT_CONCEPT_MAX_BOX_SIZE,
    "--concept-max-box-size"
  );
  const conceptNmsThreshold = parseRatio(
    args.get("concept-nms-threshold"),
    DEFAULT_CONCEPT_NMS_THRESHOLD,
    "--concept-nms-threshold"
  );
  const conceptMinCandidates = parsePositiveInt(
    args.get("concept-min-candidates"),
    DEFAULT_CONCEPT_MIN_CANDIDATES,
    "--concept-min-candidates"
  );

  const resolvedFixturePath = path.resolve(fixturePath);
  const sam3Url =
    trimTrailingSlash(args.get("sam3-url")) ??
    trimTrailingSlash(process.env.SAM3_REPLAY_SAM3_URL) ??
    trimTrailingSlash(process.env.SAM3_SERVICE_URL) ??
    trimTrailingSlash(process.env.SAM3_BASE_URL) ??
    null;
  const outputDir =
    args.get("out") ??
    path.join(
      process.cwd(),
      "tmp",
      "sam3-replay",
      `${path.basename(resolvedFixturePath, path.extname(resolvedFixturePath))}-${Date.now()}`
    );

  return {
    fixturePath: resolvedFixturePath,
    outputDir: path.resolve(outputDir),
    sam3Url,
    conceptUrl:
      trimTrailingSlash(args.get("concept-url")) ??
      trimTrailingSlash(process.env.SAM3_REPLAY_CONCEPT_URL) ??
      deriveConceptUrl(sam3Url),
    conceptApiKey:
      args.get("concept-api-key") ??
      process.env.SAM3_REPLAY_CONCEPT_API_KEY ??
      process.env.SAM3_CONCEPT_API_KEY ??
      process.env.SAM3_API_KEY ??
      process.env.NDSD_SAM3_SERVICE_API_KEY ??
      null,
    dryRun: args.has("dry-run"),
    technique: technique as ReplayTechnique,
    cropSource: cropSource as CropSource,
    strategy: strategy as ParsedArgs["strategy"],
    maxCrops,
    conceptMaxBoxes,
    maxImageSize,
    timeoutMs,
    minSize,
    minAnchorOverlap,
    sourceCropMinConfidence,
    sourceCropPadding,
    sourceCropMask,
    conceptSimilarityThreshold,
    conceptFallbackSimilarityThreshold,
    conceptTopK,
    conceptFallbackTopK,
    conceptMinBoxSize,
    conceptMaxBoxSize,
    conceptNmsThreshold,
    conceptMinCandidates,
    skipHealth: args.has("skip-health"),
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number, flag: string): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function parseRatio(raw: string | undefined, fallback: number, flag: string): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`${flag} must be a number between 0 and 1`);
  }
  return parsed;
}

function parseBoolean(raw: string | undefined, fallback: boolean, flag: string): boolean {
  if (raw == null) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  throw new Error(`${flag} must be true or false`);
}

function trimTrailingSlash(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function deriveConceptUrl(sam3Url: string | null): string | null {
  if (!sam3Url) return null;

  try {
    const parsed = new URL(sam3Url);
    parsed.port = "8002";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "");
    return parsed.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBox(value: unknown): Box | null {
  const record = asRecord(value);
  const x1 = toNumber(record.x1);
  const y1 = toNumber(record.y1);
  const x2 = toNumber(record.x2);
  const y2 = toNumber(record.y2);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;

  const box = {
    x1: Math.min(x1, x2),
    y1: Math.min(y1, y2),
    x2: Math.max(x1, x2),
    y2: Math.max(y1, y2),
  };

  return isValidBox(box) ? box : null;
}

function isValidBox(box: Box): boolean {
  return (
    Number.isFinite(box.x1) &&
    Number.isFinite(box.y1) &&
    Number.isFinite(box.x2) &&
    Number.isFinite(box.y2) &&
    box.x2 > box.x1 &&
    box.y2 > box.y1
  );
}

async function readFixture(fixturePath: string): Promise<ReplayFixture> {
  const raw = await fs.readFile(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed);
  const source = asRecord(record.source);
  const rawTargets = Array.isArray(record.targets) ? record.targets : [];
  const rawBoxes = Array.isArray(source.boxes) ? source.boxes : [];
  const boxes = rawBoxes.map(parseBox).filter((box): box is Box => box != null);

  if (!source.image || typeof source.image !== "string") {
    throw new Error("Fixture source.image is required");
  }
  if (boxes.length === 0) {
    throw new Error("Fixture source.boxes must contain at least one valid box");
  }
  if (rawTargets.length === 0) {
    throw new Error("Fixture targets must contain at least one target image");
  }

  const targets = rawTargets.map((target, index) => {
    const targetRecord = asRecord(target);
    if (!targetRecord.image || typeof targetRecord.image !== "string") {
      throw new Error(`Fixture target at index ${index} is missing image`);
    }
    return {
      id: typeof targetRecord.id === "string" ? targetRecord.id : undefined,
      image: targetRecord.image,
    };
  });

  return {
    name: typeof record.name === "string" ? record.name : undefined,
    className: typeof record.className === "string" ? record.className : "detection",
    source: {
      id: typeof source.id === "string" ? source.id : "source",
      image: source.image,
      boxes,
      exemplarCrops: Array.isArray(source.exemplarCrops)
        ? source.exemplarCrops.filter((crop): crop is string => typeof crop === "string")
        : undefined,
      exemplarCropFiles: Array.isArray(source.exemplarCropFiles)
        ? source.exemplarCropFiles.filter((crop): crop is string => typeof crop === "string")
        : undefined,
    },
    targets,
  };
}

async function loadImage(reference: string, baseDir: string, fallbackId: string): Promise<LoadedImage> {
  const buffer = await readImageBuffer(reference, baseDir);
  const metadata = await sharp(buffer).metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;

  if (width <= 0 || height <= 0) {
    throw new Error(`Could not read image dimensions for ${reference}`);
  }

  return {
    id: fallbackId,
    reference,
    buffer,
    width,
    height,
  };
}

async function readImageBuffer(reference: string, baseDir: string): Promise<Buffer> {
  if (/^https?:\/\//i.test(reference)) {
    const response = await fetch(reference, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) {
      throw new Error(`Failed to fetch image ${reference}: ${response.status}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  const filePath = path.isAbsolute(reference) ? reference : path.resolve(baseDir, reference);
  return fs.readFile(filePath);
}

async function loadProvidedCrops(source: SourceFixture, baseDir: string): Promise<string[]> {
  const crops: string[] = [];

  for (const crop of source.exemplarCrops ?? []) {
    const normalized = normalizeBase64Image(crop);
    if (normalized) crops.push(normalized);
  }

  for (const cropFile of source.exemplarCropFiles ?? []) {
    const buffer = await readImageBuffer(cropFile, baseDir);
    crops.push(buffer.toString("base64"));
  }

  return crops;
}

function normalizeBase64Image(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (DATA_URL_PREFIX.test(trimmed)) {
    const [, data] = trimmed.split("base64,");
    return data ? data.trim() : null;
  }

  return BASE64_REGEX.test(trimmed) ? trimmed : null;
}

async function resizeForSam3(
  imageBuffer: Buffer,
  maxImageSize: number
): Promise<{ buffer: Buffer; scaling: ScalingInfo }> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const originalWidth = metadata.width ?? 0;
  const originalHeight = metadata.height ?? 0;
  const maxDimension = Math.max(originalWidth, originalHeight);

  if (!originalWidth || !originalHeight) {
    throw new Error("Image dimensions could not be read");
  }

  if (maxDimension <= maxImageSize) {
    return {
      buffer: await image.jpeg({ quality: 90 }).toBuffer(),
      scaling: {
        originalWidth,
        originalHeight,
        scaledWidth: originalWidth,
        scaledHeight: originalHeight,
        scaleFactor: 1,
      },
    };
  }

  const scaleFactor = maxImageSize / maxDimension;
  const scaledWidth = Math.round(originalWidth * scaleFactor);
  const scaledHeight = Math.round(originalHeight * scaleFactor);

  return {
    buffer: await image.resize(scaledWidth, scaledHeight).jpeg({ quality: 90 }).toBuffer(),
    scaling: {
      originalWidth,
      originalHeight,
      scaledWidth,
      scaledHeight,
      scaleFactor,
    },
  };
}

function scaleBox(box: Box, scaleFactor: number): Box {
  return {
    x1: Math.round(box.x1 * scaleFactor),
    y1: Math.round(box.y1 * scaleFactor),
    x2: Math.round(box.x2 * scaleFactor),
    y2: Math.round(box.y2 * scaleFactor),
  };
}

function scaleBboxToOriginal(
  bbox: [number, number, number, number],
  scaleFactor: number
): [number, number, number, number] {
  const inverse = 1 / scaleFactor;
  return [
    Math.round(bbox[0] * inverse),
    Math.round(bbox[1] * inverse),
    Math.round(bbox[2] * inverse),
    Math.round(bbox[3] * inverse),
  ];
}

function scalePolygonToOriginal(
  polygon: unknown,
  scaleFactor: number
): [number, number][] | undefined {
  if (!Array.isArray(polygon)) return undefined;
  const inverse = 1 / scaleFactor;
  const points: [number, number][] = [];

  for (const point of polygon) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = toNumber(point[0]);
    const y = toNumber(point[1]);
    if (x == null || y == null) continue;
    points.push([Math.round(x * inverse), Math.round(y * inverse)]);
  }

  return points.length >= 3 ? points : undefined;
}

async function buildCropsFromBoxes(
  imageBuffer: Buffer,
  boxes: Box[],
  maxCrops: number
): Promise<string[]> {
  const image = sharp(imageBuffer);
  const metadata = await image.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) return [];

  const crops: string[] = [];
  for (const box of boxes.slice(0, maxCrops)) {
    const left = Math.max(0, Math.min(width - 1, Math.round(box.x1)));
    const top = Math.max(0, Math.min(height - 1, Math.round(box.y1)));
    const right = Math.max(left + 1, Math.min(width, Math.round(box.x2)));
    const bottom = Math.max(top + 1, Math.min(height, Math.round(box.y2)));
    const cropWidth = right - left;
    const cropHeight = bottom - top;
    if (cropWidth <= 1 || cropHeight <= 1) continue;

    const cropBuffer = await image
      .clone()
      .extract({ left, top, width: cropWidth, height: cropHeight })
      .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    crops.push(cropBuffer.toString("base64"));
  }

  return crops;
}

async function writeCropFiles(outputDir: string, strategy: StrategyName, crops: string[]): Promise<string[]> {
  const cropDir = path.join(outputDir, "crops", strategy);
  await fs.mkdir(cropDir, { recursive: true });

  const cropFiles: string[] = [];
  for (let i = 0; i < crops.length; i += 1) {
    const cropPath = path.join(cropDir, `${String(i + 1).padStart(2, "0")}.jpg`);
    await fs.writeFile(cropPath, Buffer.from(crops[i], "base64"));
    cropFiles.push(cropPath);
  }

  return cropFiles;
}

async function callSam3WithBoxes(
  sam3Url: string,
  image: LoadedImage,
  boxes: Box[],
  className: string,
  options: ParsedArgs
): Promise<Sam3RunResult> {
  const resized = await resizeForSam3(image.buffer, options.maxImageSize);
  const payload = {
    image: resized.buffer.toString("base64"),
    boxes: boxes.map((box) => scaleBox(box, resized.scaling.scaleFactor)),
    class_name: className,
    min_size: options.minSize,
    max_size: null,
    return_polygons: true,
  };

  const response = await postJson(`${sam3Url}/segment`, payload, options.timeoutMs);
  return parseSam3Result(response, resized.scaling, {
    endpoint: "/segment",
    mode: "boxes",
    boxCount: boxes.length,
    scaling: resized.scaling,
  });
}

async function callSam3WithCrops(
  sam3Url: string,
  image: LoadedImage,
  crops: string[],
  className: string,
  options: ParsedArgs
): Promise<Sam3RunResult> {
  const resized = await resizeForSam3(image.buffer, options.maxImageSize);
  const payload = {
    image: resized.buffer.toString("base64"),
    exemplar_crops: crops,
    class_name: className,
    return_polygons: true,
  };

  const response = await postJson(`${sam3Url}/segment`, payload, options.timeoutMs);
  return parseSam3Result(response, resized.scaling, {
    endpoint: "/segment",
    mode: "exemplar_crops",
    cropCount: crops.length,
    scaling: resized.scaling,
  });
}

async function warmupConceptService(conceptUrl: string, options: ParsedArgs): Promise<unknown> {
  return postJson(`${conceptUrl}/warmup`, {}, options.timeoutMs, conceptHeaders(options));
}

async function createConceptExemplar(
  conceptUrl: string,
  source: LoadedImage,
  boxes: Box[],
  className: string,
  options: ParsedArgs
): Promise<{ exemplarId: string; rawResponse: unknown }> {
  const resized = await resizeForSam3(source.buffer, options.maxImageSize);
  const payload = {
    image: resized.buffer.toString("base64"),
    boxes: boxes.map((box) => scaleBox(box, resized.scaling.scaleFactor)),
    class_name: className,
    image_id: source.id,
  };
  const response = await postJson(
    `${conceptUrl}/api/v1/exemplars/create`,
    payload,
    options.timeoutMs,
    conceptHeaders(options)
  );
  const record = asRecord(response);
  const exemplarId = typeof record.exemplar_id === "string" ? record.exemplar_id : "";
  if (!exemplarId) {
    throw new Error("Concept create response did not include exemplar_id");
  }
  return { exemplarId, rawResponse: response };
}

async function applyConceptExemplar(
  conceptUrl: string,
  exemplarId: string,
  image: LoadedImage,
  options: ParsedArgs,
  fallback = false
): Promise<{ detections: Detection[]; rawResponse: unknown; scaling: ScalingInfo }> {
  const resized = await resizeForSam3(image.buffer, options.maxImageSize);
  const payload = {
    exemplar_id: exemplarId,
    images: [resized.buffer.toString("base64")],
    image_ids: [image.id],
    return_polygons: true,
    similarity_threshold: fallback
      ? options.conceptFallbackSimilarityThreshold
      : options.conceptSimilarityThreshold,
    top_k: fallback ? options.conceptFallbackTopK : options.conceptTopK,
    min_box_size: options.conceptMinBoxSize,
    max_box_size: options.conceptMaxBoxSize,
    nms_threshold: options.conceptNmsThreshold,
  };
  const response = await postJson(
    `${conceptUrl}/api/v1/exemplars/apply`,
    payload,
    options.timeoutMs,
    conceptHeaders(options)
  );
  return {
    detections: parseConceptApplyDetections(response, resized.scaling),
    rawResponse: response,
    scaling: resized.scaling,
  };
}

function parseConceptApplyDetections(response: unknown, scaling: ScalingInfo): Detection[] {
  const record = asRecord(response);
  const resultItem = Array.isArray(record.results) ? record.results[0] : null;
  const rawDetections = Array.isArray(resultItem?.detections) ? resultItem.detections : [];
  return rawDetections
    .map((detection) => parseDetection(detection, scaling))
    .filter((detection): detection is Detection => detection != null);
}

async function postJson(
  url: string,
  payload: unknown,
  timeoutMs: number,
  headers: Record<string, string> = { "Content-Type": "application/json" }
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(`SAM3 API error ${response.status}: ${errorText.substring(0, 500)}`);
  }

  return response.json();
}

function conceptHeaders(options: ParsedArgs): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.conceptApiKey) {
    headers["X-API-Key"] = options.conceptApiKey;
  }
  return headers;
}

function parseSam3Result(
  response: unknown,
  scaling: ScalingInfo,
  request: Sam3RunResult["request"]
): Sam3RunResult {
  const record = asRecord(response);
  const rawDetections = Array.isArray(record.detections) ? record.detections : [];
  const detections = rawDetections.map((detection) => parseDetection(detection, scaling)).filter(
    (detection): detection is Detection => detection != null
  );
  const count = toNumber(record.count) ?? detections.length;

  return {
    ok: true,
    detections,
    count,
    request,
    rawResponse: response,
  };
}

function parseDetection(value: unknown, scaling: ScalingInfo): Detection | null {
  const record = asRecord(value);
  const bbox = parseBbox(record.bbox);
  if (!bbox) return null;

  const confidence = toNumber(record.confidence) ?? toNumber(record.score) ?? 0;
  const similarity = toNumber(record.similarity);
  const className =
    (typeof record.class_name === "string" && record.class_name) ||
    (typeof record.className === "string" && record.className) ||
    "detection";

  return {
    bbox: scaleBboxToOriginal(bbox, scaling.scaleFactor),
    confidence: similarity ?? confidence,
    similarity: similarity ?? undefined,
    className,
    polygon: scalePolygonToOriginal(record.polygon, scaling.scaleFactor),
  };
}

function parseBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length < 4) return null;
  const x1 = toNumber(value[0]);
  const y1 = toNumber(value[1]);
  const x2 = toNumber(value[2]);
  const y2 = toNumber(value[3]);
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  if (x2 <= x1 || y2 <= y1) return null;
  return [x1, y1, x2, y2];
}

function detectionToBox(detection: Detection): Box {
  return {
    x1: detection.bbox[0],
    y1: detection.bbox[1],
    x2: detection.bbox[2],
    y2: detection.bbox[3],
  };
}

function mergeSourceBoxes(
  anchorBoxes: Box[],
  sourceDetections: Detection[],
  minAnchorOverlap: number,
  maxCrops: number
): Box[] {
  const validAnchors = anchorBoxes.filter(isValidBox);
  const selected: Box[] = [...validAnchors];
  const sourceBoxes = sourceDetections
    .map((detection) => ({
      box: detectionToBox(detection),
      confidence: detection.confidence,
    }))
    .filter(({ box }) => isValidBox(box))
    .filter(({ box }) =>
      validAnchors.length === 0
        ? true
        : validAnchors.some((anchorBox) => boxesOverlapEnough(box, anchorBox, minAnchorOverlap))
    )
    .sort((left, right) => right.confidence - left.confidence)
    .map(({ box }) => box);

  for (const box of sourceBoxes) {
    if (!selected.some((existing) => boxesAreNearDuplicates(existing, box))) {
      selected.push(box);
    }
    if (selected.length >= maxCrops) break;
  }

  return selected.slice(0, maxCrops);
}

function boxArea(box: Box): number {
  return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

function boxIntersectionArea(first: Box, second: Box): number {
  const x1 = Math.max(first.x1, second.x1);
  const y1 = Math.max(first.y1, second.y1);
  const x2 = Math.min(first.x2, second.x2);
  const y2 = Math.min(first.y2, second.y2);
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function boxesOverlapEnough(first: Box, second: Box, minAnchorOverlap: number): boolean {
  const smallerArea = Math.min(boxArea(first), boxArea(second));
  return smallerArea > 0 && boxIntersectionArea(first, second) / smallerArea >= minAnchorOverlap;
}

function boxesAreNearDuplicates(first: Box, second: Box): boolean {
  const intersection = boxIntersectionArea(first, second);
  const union = boxArea(first) + boxArea(second) - intersection;
  return union > 0 && intersection / union >= 0.9;
}

function bboxIou(first: [number, number, number, number], second: [number, number, number, number]): number {
  const firstBox = { x1: first[0], y1: first[1], x2: first[2], y2: first[3] };
  const secondBox = { x1: second[0], y1: second[1], x2: second[2], y2: second[3] };
  const intersection = boxIntersectionArea(firstBox, secondBox);
  const union = boxArea(firstBox) + boxArea(secondBox) - intersection;
  return union > 0 ? intersection / union : 0;
}

function detectionScore(detection: Detection): number {
  return typeof detection.similarity === "number" ? detection.similarity : detection.confidence;
}

function filterConceptDetections(detections: Detection[], threshold: number): Detection[] {
  return detections
    .filter((detection) => detectionScore(detection) >= threshold)
    .sort((left, right) => detectionScore(right) - detectionScore(left));
}

function dedupeConceptDetections(
  detections: Detection[],
  nmsThreshold: number,
  limit: number
): Detection[] {
  const selected: Detection[] = [];
  for (const detection of detections.sort((left, right) => detectionScore(right) - detectionScore(left))) {
    if (selected.some((existing) => bboxIou(existing.bbox, detection.bbox) > nmsThreshold)) {
      continue;
    }
    selected.push(detection);
    if (selected.length >= limit) break;
  }
  return selected;
}

async function checkHealth(sam3Url: string, timeoutMs: number): Promise<unknown> {
  const response = await fetch(`${sam3Url}/health`, {
    signal: AbortSignal.timeout(Math.min(timeoutMs, 10000)),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`SAM3 health check failed ${response.status}: ${body.substring(0, 300)}`);
  }

  return response.json().catch(() => ({}));
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function renderOverlay({
  image,
  outputPath,
  detections,
  boxes = [],
  title,
  color,
}: {
  image: LoadedImage;
  outputPath: string;
  detections: Detection[];
  boxes?: Box[];
  title: string;
  color: string;
}): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const sourceBoxes = boxes
    .map(
      (box, index) =>
        `<rect x="${box.x1}" y="${box.y1}" width="${box.x2 - box.x1}" height="${box.y2 - box.y1}" fill="none" stroke="#2563eb" stroke-width="5"/><text x="${box.x1}" y="${Math.max(
          24,
          box.y1 - 8
        )}" font-size="28" font-family="Arial, sans-serif" fill="#2563eb">source ${index + 1}</text>`
    )
    .join("");

  const detectionShapes = detections
    .map((detection, index) => {
      const [x1, y1, x2, y2] = detection.bbox;
      const label = `${index + 1}: ${Math.round(detection.confidence * 100)}%`;
      const polygon = detection.polygon?.length
        ? `<polygon points="${detection.polygon.map(([x, y]) => `${x},${y}`).join(" ")}" fill="${color}22" stroke="${color}" stroke-width="3"/>`
        : "";
      return `${polygon}<rect x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}" fill="none" stroke="${color}" stroke-width="4"/><rect x="${x1}" y="${Math.max(
        0,
        y1 - 32
      )}" width="${Math.max(70, label.length * 18)}" height="30" fill="${color}" opacity="0.9"/><text x="${x1 + 6}" y="${Math.max(
        22,
        y1 - 9
      )}" font-size="22" font-family="Arial, sans-serif" fill="#ffffff">${escapeXml(label)}</text>`;
    })
    .join("");

  const noDetectionText =
    detections.length === 0
      ? `<text x="28" y="92" font-size="34" font-family="Arial, sans-serif" fill="#dc2626">No detections returned</text>`
      : "";

  const svg = `<svg width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="0" y="0" width="${Math.min(image.width, 1300)}" height="118" fill="#ffffff" opacity="0.82"/>
    <text x="28" y="46" font-size="34" font-family="Arial, sans-serif" fill="#111827">${escapeXml(title)}</text>
    <text x="28" y="84" font-size="26" font-family="Arial, sans-serif" fill="#374151">${detections.length} detection(s)</text>
    ${noDetectionText}
    ${sourceBoxes}
    ${detectionShapes}
  </svg>`;

  await sharp(image.buffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toFile(outputPath);
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function strategyList(strategy: ParsedArgs["strategy"], cropSource: CropSource): StrategyName[] {
  if (cropSource === "operator") return ["baseline"];
  if (cropSource === "source-detections") return ["enhanced"];
  if (strategy === "both") return ["baseline", "enhanced"];
  return [strategy];
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const fixture = await readFixture(options.fixturePath);
  const fixtureDir = path.dirname(options.fixturePath);
  const className = fixture.className ?? "detection";

  if (!options.dryRun && !options.sam3Url) {
    throw new Error("--sam3-url is required unless --dry-run is set");
  }
  if (
    !options.dryRun &&
    (options.technique === "concept" || options.technique === "both") &&
    !options.conceptUrl
  ) {
    throw new Error("--concept-url is required for --technique concept unless it can be derived from --sam3-url");
  }

  await fs.mkdir(options.outputDir, { recursive: true });

  const source = await loadImage(
    fixture.source.image,
    fixtureDir,
    fixture.source.id ?? "source"
  );
  const targets = await Promise.all(
    fixture.targets.map((target, index) =>
      loadImage(target.image, fixtureDir, target.id ?? `target-${index + 1}`)
    )
  );
  const providedCrops = await loadProvidedCrops(fixture.source, fixtureDir);
  const baselineCrops =
    providedCrops.length > 0
      ? providedCrops.slice(0, options.maxCrops)
      : await buildCropsFromBoxes(source.buffer, fixture.source.boxes, options.maxCrops);

  let health: unknown = null;
  if (!options.dryRun && !options.skipHealth && options.sam3Url) {
    health = await checkHealth(options.sam3Url, options.timeoutMs);
  }

  let sourceResult: Sam3RunResult | null = null;
  const sourceDir = path.join(options.outputDir, "source");
  if (options.dryRun) {
    await renderOverlay({
      image: source,
      outputPath: path.join(sourceDir, "source-boxes.overlay.png"),
      detections: [],
      boxes: fixture.source.boxes,
      title: `${fixture.name ?? "SAM3 replay"} source boxes`,
      color: "#2563eb",
    });
  } else if (options.sam3Url) {
    sourceResult = await callSam3WithBoxes(
      options.sam3Url,
      source,
      fixture.source.boxes,
      className,
      options
    );
    await writeJson(path.join(sourceDir, "source-box-match.json"), sourceResult);
    await renderOverlay({
      image: source,
      outputPath: path.join(sourceDir, "source-box-match.overlay.png"),
      detections: sourceResult.detections,
      boxes: fixture.source.boxes,
      title: `${fixture.name ?? "SAM3 replay"} source box match`,
      color: "#16a34a",
    });
  }

  const enhancedBoxes = sourceResult
    ? mergeSourceBoxes(
        fixture.source.boxes,
        sourceResult.detections,
        options.minAnchorOverlap,
        options.maxCrops
      )
    : fixture.source.boxes.slice(0, options.maxCrops);
  const sourceDetectionCrops = sourceResult
    ? await buildExemplarCropsFromDetections({
        imageBuffer: source.buffer,
        detections: sourceResult.detections,
        maxCrops: options.maxCrops,
        minConfidence: options.sourceCropMinConfidence,
        paddingRatio: options.sourceCropPadding,
        maskPolygons: options.sourceCropMask,
      })
    : [];
  const enhancedCrops =
    sourceDetectionCrops.length > 0
      ? sourceDetectionCrops
      : await buildCropsFromBoxes(source.buffer, enhancedBoxes, options.maxCrops);

  const strategyManifests: StrategyManifest[] = [];
  if (options.technique === "crops" || options.technique === "both") {
    for (const strategy of strategyList(options.strategy, options.cropSource)) {
      const crops = strategy === "baseline" ? baselineCrops : enhancedCrops;
      const sourceBoxesUsed = strategy === "baseline" ? fixture.source.boxes.slice(0, options.maxCrops) : enhancedBoxes;
      const cropFiles = await writeCropFiles(options.outputDir, strategy, crops);
      const strategyDir = path.join(options.outputDir, strategy);
      const targetManifests: TargetManifest[] = [];

      for (const target of targets) {
        const safeTargetId = sanitizeFileName(target.id);
        const jsonPath = path.join(strategyDir, `${safeTargetId}.json`);
        const overlayPath = path.join(strategyDir, `${safeTargetId}.overlay.png`);

        if (options.dryRun) {
          await writeJson(jsonPath, {
            dryRun: true,
            target: target.id,
            strategy,
            cropCount: crops.length,
          });
          await renderOverlay({
            image: target,
            outputPath: overlayPath,
            detections: [],
            title: `${strategy} dry run: ${target.id}`,
            color: strategy === "baseline" ? "#f59e0b" : "#16a34a",
          });
          targetManifests.push({
            id: target.id,
            image: target.reference,
            count: 0,
            outcome: "dry_run",
            jsonPath,
            overlayPath,
          });
          continue;
        }

        try {
          if (!options.sam3Url) {
            throw new Error("SAM3 URL was not configured");
          }
          const result = await callSam3WithCrops(options.sam3Url, target, crops, className, options);
          await writeJson(jsonPath, result);
          await renderOverlay({
            image: target,
            outputPath: overlayPath,
            detections: result.detections,
            title: `${strategy}: ${target.id}`,
            color: strategy === "baseline" ? "#f59e0b" : "#16a34a",
          });
          targetManifests.push({
            id: target.id,
            image: target.reference,
            count: result.detections.length,
            outcome: result.detections.length > 0 ? "success" : "zero_detections",
            jsonPath,
            overlayPath,
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : "Unknown SAM3 replay error";
          await writeJson(jsonPath, {
            ok: false,
            error: errorMessage,
            strategy,
            target: target.id,
          });
          await renderOverlay({
            image: target,
            outputPath: overlayPath,
            detections: [],
            title: `${strategy}: ${target.id} error`,
            color: "#dc2626",
          });
          targetManifests.push({
            id: target.id,
            image: target.reference,
            count: 0,
            outcome: "error",
            jsonPath,
            overlayPath,
            error: errorMessage,
          });
        }
      }

      strategyManifests.push({
        name: strategy,
        cropSource: strategy === "baseline" ? "operator" : "source-detections",
        cropCount: crops.length,
        cropFiles,
        sourceBoxesUsed,
        targets: targetManifests,
      });
    }
  }

  let conceptManifest: ConceptManifest | null = null;
  if (options.technique === "concept" || options.technique === "both") {
    conceptManifest = await runConceptReplay({
      options,
      conceptUrl: options.conceptUrl,
      source,
      targets,
      sourceResult,
      anchorBoxes: fixture.source.boxes,
      className,
      name: fixture.name ?? "SAM3 replay",
    });
  }

  const manifest = {
    fixture: {
      path: options.fixturePath,
      name: fixture.name ?? null,
      className,
    },
    createdAt: new Date().toISOString(),
    dryRun: options.dryRun,
    sam3Url: options.sam3Url,
    conceptUrl: options.conceptUrl,
    health,
    options: {
      technique: options.technique,
      strategy: options.strategy,
      maxCrops: options.maxCrops,
      cropSource: options.cropSource,
      conceptMaxBoxes: options.conceptMaxBoxes,
      maxImageSize: options.maxImageSize,
      timeoutMs: options.timeoutMs,
      minSize: options.minSize,
      minAnchorOverlap: options.minAnchorOverlap,
      sourceCropMinConfidence: options.sourceCropMinConfidence,
      sourceCropPadding: options.sourceCropPadding,
      sourceCropMask: options.sourceCropMask,
      conceptSimilarityThreshold: options.conceptSimilarityThreshold,
      conceptFallbackSimilarityThreshold: options.conceptFallbackSimilarityThreshold,
      conceptTopK: options.conceptTopK,
      conceptFallbackTopK: options.conceptFallbackTopK,
      conceptMinBoxSize: options.conceptMinBoxSize,
      conceptMaxBoxSize: options.conceptMaxBoxSize,
      conceptNmsThreshold: options.conceptNmsThreshold,
      conceptMinCandidates: options.conceptMinCandidates,
    },
    source: {
      id: source.id,
      image: source.reference,
      width: source.width,
      height: source.height,
      boxes: fixture.source.boxes,
      detectionCount: sourceResult?.detections.length ?? null,
      resultPath: options.dryRun ? null : path.join(sourceDir, "source-box-match.json"),
      overlayPath: options.dryRun
        ? path.join(sourceDir, "source-boxes.overlay.png")
        : path.join(sourceDir, "source-box-match.overlay.png"),
    },
    strategies: strategyManifests,
    sourceDetectionCropCount: sourceDetectionCrops.length,
    concept: conceptManifest,
  };

  const manifestPath = path.join(options.outputDir, "manifest.json");
  await writeJson(manifestPath, manifest);
  printSummary(manifestPath, strategyManifests, conceptManifest, sourceResult, options.dryRun);
}

async function runConceptReplay({
  options,
  conceptUrl,
  source,
  targets,
  sourceResult,
  anchorBoxes,
  className,
  name,
}: {
  options: ParsedArgs;
  conceptUrl: string | null;
  source: LoadedImage;
  targets: LoadedImage[];
  sourceResult: Sam3RunResult | null;
  anchorBoxes: Box[];
  className: string;
  name: string;
}): Promise<ConceptManifest> {
  const conceptDir = path.join(options.outputDir, "concept");
  const targetManifests: ConceptManifest["targets"] = [];
  const sourceBoxesUsed = sourceResult
    ? mergeSourceBoxes(anchorBoxes, sourceResult.detections, options.minAnchorOverlap, options.conceptMaxBoxes)
    : anchorBoxes.slice(0, options.conceptMaxBoxes);

  if (options.dryRun) {
    return {
      exemplarId: null,
      sourceBoxesUsed,
      targets: targetManifests,
    };
  }

  if (!conceptUrl) {
    throw new Error("Concept URL was not configured");
  }

  const warmup = await warmupConceptService(conceptUrl, options);
  await writeJson(path.join(conceptDir, "warmup.json"), warmup);

  const exemplar = await createConceptExemplar(conceptUrl, source, sourceBoxesUsed, className, options);
  await writeJson(path.join(conceptDir, "exemplar.json"), {
    exemplarId: exemplar.exemplarId,
    sourceBoxesUsed,
    rawResponse: exemplar.rawResponse,
  });

  for (const target of targets) {
    const safeTargetId = sanitizeFileName(target.id);
    const jsonPath = path.join(conceptDir, `${safeTargetId}.json`);
    const overlayPath = path.join(conceptDir, `${safeTargetId}.overlay.png`);

    try {
      const strict = await applyConceptExemplar(conceptUrl, exemplar.exemplarId, target, options);
      const strictCandidates = filterConceptDetections(strict.detections, options.conceptSimilarityThreshold);
      let fallbackCandidates: Detection[] = [];
      let fallbackRaw: unknown = null;

      if (strictCandidates.length < options.conceptMinCandidates) {
        const fallback = await applyConceptExemplar(conceptUrl, exemplar.exemplarId, target, options, true);
        fallbackCandidates = filterConceptDetections(
          fallback.detections,
          options.conceptFallbackSimilarityThreshold
        );
        fallbackRaw = fallback.rawResponse;
      }

      const candidates = dedupeConceptDetections(
        [...strictCandidates, ...fallbackCandidates],
        options.conceptNmsThreshold,
        Math.max(options.conceptTopK, options.conceptMinCandidates)
      );

      let refined: Detection[] = [];
      if (options.sam3Url && candidates.length > 0) {
        const refineResult = await callSam3WithBoxes(
          options.sam3Url,
          target,
          candidates.map(detectionToBox),
          className,
          options
        );
        refined = refineResult.detections;
      }

      const detections = mergeRefinedConceptDetections(candidates, refined);
      await writeJson(jsonPath, {
        ok: true,
        target: target.id,
        exemplarId: exemplar.exemplarId,
        strictCandidateCount: strictCandidates.length,
        fallbackCandidateCount: fallbackCandidates.length,
        candidateCount: candidates.length,
        refinedCount: refined.length,
        count: detections.length,
        detections,
        rawResponse: {
          strict: strict.rawResponse,
          fallback: fallbackRaw,
        },
      });
      await renderOverlay({
        image: target,
        outputPath: overlayPath,
        detections,
        title: `concept: ${name} / ${target.id}`,
        color: "#7c3aed",
      });
      targetManifests.push({
        id: target.id,
        image: target.reference,
        count: detections.length,
        outcome: detections.length > 0 ? "success" : "zero_detections",
        jsonPath,
        overlayPath,
        strictCandidateCount: strictCandidates.length,
        fallbackCandidateCount: fallbackCandidates.length,
        candidateCount: candidates.length,
        refinedCount: refined.length,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown SAM3 concept replay error";
      await writeJson(jsonPath, {
        ok: false,
        target: target.id,
        exemplarId: exemplar.exemplarId,
        error: errorMessage,
      });
      await renderOverlay({
        image: target,
        outputPath: overlayPath,
        detections: [],
        title: `concept: ${target.id} error`,
        color: "#dc2626",
      });
      targetManifests.push({
        id: target.id,
        image: target.reference,
        count: 0,
        outcome: "error",
        jsonPath,
        overlayPath,
        error: errorMessage,
      });
    }
  }

  return {
    exemplarId: exemplar.exemplarId,
    sourceBoxesUsed,
    targets: targetManifests,
  };
}

function mergeRefinedConceptDetections(candidates: Detection[], refined: Detection[]): Detection[] {
  if (candidates.length === 0) return [];
  if (refined.length === 0) return candidates;

  const matchedCandidateIndexes = new Set<number>();
  const acceptedRefined = refined.flatMap((detection) => {
    let bestIndex = -1;
    let bestIou = 0;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidateIou = bboxIou(detection.bbox, candidates[index].bbox);
      if (candidateIou > bestIou) {
        bestIou = candidateIou;
        bestIndex = index;
      }
    }

    if (bestIndex < 0 || bestIou < 0.1) {
      return [];
    }

    matchedCandidateIndexes.add(bestIndex);
    const candidate = candidates[bestIndex];
    return [{
      ...detection,
      confidence: detectionScore(candidate),
      similarity: candidate.similarity,
    }];
  });

  if (acceptedRefined.length === 0) {
    return candidates;
  }

  const unmatchedCandidates = candidates.filter((_, index) => !matchedCandidateIndexes.has(index));
  return [...acceptedRefined, ...unmatchedCandidates];
}

function sanitizeFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "target";
}

function printSummary(
  manifestPath: string,
  strategies: StrategyManifest[],
  concept: ConceptManifest | null,
  sourceResult: Sam3RunResult | null,
  dryRun: boolean
): void {
  console.log("");
  console.log("SAM3 replay complete");
  console.log(`Manifest: ${manifestPath}`);
  console.log(
    dryRun
      ? "Source: dry run only"
      : `Source box match: ${sourceResult?.detections.length ?? 0} detection(s)`
  );

  for (const strategy of strategies) {
    const counts = strategy.targets
      .map((target) => `${target.id}=${target.outcome === "error" ? "error" : target.count}`)
      .join(", ");
    console.log(`${strategy.name}/${strategy.cropSource}: ${strategy.cropCount} crop(s), ${counts}`);
  }

  if (concept) {
    const counts = concept.targets
      .map((target) =>
        `${target.id}=${target.outcome === "error" ? "error" : target.count}` +
        (target.candidateCount != null ? ` (${target.candidateCount} candidates)` : "")
      )
      .join(", ");
    console.log(`concept: ${concept.sourceBoxesUsed.length} source box(es), ${counts}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
