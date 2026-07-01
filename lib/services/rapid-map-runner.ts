import { execFile } from "child_process";
import { access, readFile } from "fs/promises";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const DEFAULT_RUNNER_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const RUNNER_MAX_BUFFER = 20 * 1024 * 1024;

export type RapidMapArtifactRole =
  | "geotiff"
  | "preview"
  | "overlay"
  | "metadata"
  | "summary"
  | "tiles"
  | "other";

export interface RapidMapRunnerArtifact {
  path: string;
  role?: RapidMapArtifactRole;
  contentType?: string;
  targetKey?: string;
}

export interface RapidMapRunnerSummary {
  sourceImageCount?: number;
  renderedImageCount?: number;
  excludedImageCount?: number;
  estimatedErrorMeters?: number;
  rasterWidth?: number;
  rasterHeight?: number;
  bounds?: unknown;
}

export interface RapidMapRunnerOrthomosaic {
  name?: string;
  description?: string;
  bounds?: unknown;
  centerLat?: number;
  centerLon?: number;
  resolutionCmPerPixel?: number;
  areaHectares?: number;
  imageCount?: number;
  rasterWidth?: number;
  rasterHeight?: number;
  minZoom?: number;
  maxZoom?: number;
  captureDate?: string;
  crs?: unknown;
  affineTransform?: unknown;
  nodataValues?: unknown;
  bandMetadata?: unknown;
}

export interface RapidMapRunnerManifest {
  version?: number;
  summary?: RapidMapRunnerSummary;
  artifacts?: RapidMapRunnerArtifact[];
  orthomosaic?: RapidMapRunnerOrthomosaic;
}

export interface RapidMapRunnerRequest {
  runId: string;
  jobFilePath: string;
  outputDirectory: string;
}

export class RapidMapRunnerNotConfiguredError extends Error {
  constructor() {
    super(
      "Rapid Map runner is not configured. Set RAPID_MAP_RUNNER_COMMAND on the rapid-map worker container."
    );
    this.name = "RapidMapRunnerNotConfiguredError";
  }
}

function parseRunnerArgs(): string[] {
  const rawArgs = process.env.RAPID_MAP_RUNNER_ARGS;
  if (!rawArgs) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawArgs);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to the clear configuration error below.
  }

  throw new Error("RAPID_MAP_RUNNER_ARGS must be a JSON string array.");
}

async function readRunnerManifest(outputDirectory: string): Promise<RapidMapRunnerManifest> {
  const manifestPath = path.join(outputDirectory, "manifest.json");
  await access(manifestPath);

  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as RapidMapRunnerManifest;

  if (!manifest || typeof manifest !== "object") {
    throw new Error("Rapid Map runner manifest is invalid.");
  }

  return manifest;
}

export async function runRapidMapRunner(
  request: RapidMapRunnerRequest
): Promise<RapidMapRunnerManifest> {
  const command = process.env.RAPID_MAP_RUNNER_COMMAND;
  if (!command) {
    throw new RapidMapRunnerNotConfiguredError();
  }

  const timeout = Number(process.env.RAPID_MAP_RUNNER_TIMEOUT_MS || DEFAULT_RUNNER_TIMEOUT_MS);
  const args = [
    ...parseRunnerArgs(),
    "--job",
    request.jobFilePath,
    "--output",
    request.outputDirectory,
  ];

  await execFileAsync(command, args, {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RAPID_MAP_RUN_ID: request.runId,
      RAPID_MAP_JOB_FILE: request.jobFilePath,
      RAPID_MAP_OUTPUT_DIR: request.outputDirectory,
    },
    maxBuffer: RUNNER_MAX_BUFFER,
    timeout,
  });

  return readRunnerManifest(request.outputDirectory);
}
