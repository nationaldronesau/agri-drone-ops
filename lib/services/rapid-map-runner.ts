import { spawn } from "child_process";
import { access, readFile } from "fs/promises";
import path from "path";

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
  gpsOutlierCount?: number;
  pitchFilteredCount?: number;
  elapsedSeconds?: number;
  targetEpsg?: string;
  blend?: string;
  skipped?: unknown[];
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
  reportProgress?: (progress: number) => Promise<void> | void;
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

function runRunnerProcess(
  command: string,
  args: string[],
  request: RapidMapRunnerRequest,
  timeout: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        RAPID_MAP_RUN_ID: request.runId,
        RAPID_MAP_JOB_FILE: request.jobFilePath,
        RAPID_MAP_OUTPUT_DIR: request.outputDirectory,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutLineBuffer = "";
    let progress = 30;
    let progressUpdates = Promise.resolve();
    let terminationError: Error | undefined;

    const terminate = (error: Error) => {
      if (!terminationError) {
        terminationError = error;
        child.kill("SIGKILL");
      }
    };

    const capture = (chunk: Buffer, chunks: Buffer[], stream: "stdout" | "stderr") => {
      if (stream === "stdout") {
        stdoutBytes += chunk.length;
        if (stdoutBytes > RUNNER_MAX_BUFFER) {
          terminate(new Error("Rapid Map runner stdout exceeded the 20 MB output limit."));
          return;
        }
      } else {
        stderrBytes += chunk.length;
        if (stderrBytes > RUNNER_MAX_BUFFER) {
          terminate(new Error("Rapid Map runner stderr exceeded the 20 MB output limit."));
          return;
        }
      }

      chunks.push(chunk);
    };

    const reportStageLines = (chunk: Buffer) => {
      stdoutLineBuffer += chunk.toString("utf8");
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trimStart().startsWith("+ ")) {
          continue;
        }

        progress = Math.min(68, progress + 5);
        const stageProgress = progress;
        progressUpdates = progressUpdates.then(async () => {
          await request.reportProgress?.(stageProgress);
        });
      }
    };

    child.stdout.on("data", (chunk: Buffer) => {
      capture(chunk, stdoutChunks, "stdout");
      reportStageLines(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      capture(chunk, stderrChunks, "stderr");
    });

    const timeoutHandle = setTimeout(() => {
      terminate(new Error(`Rapid Map runner timed out after ${timeout} ms.`));
    }, timeout);

    child.once("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.once("close", (code, signal) => {
      clearTimeout(timeoutHandle);
      void progressUpdates.then(
        () => {
          if (terminationError) {
            reject(terminationError);
            return;
          }

          if (code !== 0) {
            const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
            const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();
            const detail = stderr || stdout;
            reject(
              new Error(
                `Rapid Map runner exited with code ${code ?? "null"}${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`
              )
            );
            return;
          }

          resolve();
        },
        reject
      );
    });
  });
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

  await runRunnerProcess(command, args, request, timeout);

  return readRunnerManifest(request.outputDirectory);
}
