import { createReadStream } from "fs";
import {
  mkdir,
  mkdtemp,
  rm,
  stat,
  writeFile,
} from "fs/promises";
import os from "os";
import path from "path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { Prisma, RapidMapRunStatus } from "@prisma/client";
import type { RapidMapSourceType } from "@prisma/client";
import prisma from "@/lib/db";
import type { RapidMapJobResult } from "@/lib/queue/rapid-map-queue";
import { S3Service, assertValidS3Key, s3Client } from "@/lib/services/s3";
import {
  RapidMapRunnerArtifact,
  RapidMapRunnerManifest,
  RapidMapRunnerNotConfiguredError,
  runRapidMapRunner,
} from "@/lib/services/rapid-map-runner";

type RapidMapLogEntry = {
  stage: string;
  message: string;
  timestamp: string;
  details?: Prisma.InputJsonObject;
};

type RapidMapProgressReporter = (progress: number) => Promise<void> | void;

export interface ProcessRapidMapRunOptions {
  reportProgress?: RapidMapProgressReporter;
}

type UploadedRapidMapArtifact = RapidMapRunnerArtifact & {
  s3Key: string;
  bucket: string;
  fileSize: number;
};

interface RapidMapSourceSpec {
  type: RapidMapSourceType;
  sourcePath: string | null;
  sourceBucket?: string;
  sourceAssetIds: string[];
  estimatedSourceImageCount?: number;
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".tif",
  ".tiff",
  ".png",
  ".dng",
]);

function buildLogEntry(
  stage: string,
  message: string,
  details?: Prisma.InputJsonObject
): RapidMapLogEntry {
  return {
    stage,
    message,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
}

function normalizeProcessingLog(value: Prisma.JsonValue | null): Prisma.InputJsonArray {
  if (Array.isArray(value)) {
    return value.filter((entry) => Boolean(entry)) as Prisma.InputJsonArray;
  }

  if (value && typeof value === "object") {
    return [value as Prisma.InputJsonObject];
  }

  return [];
}

async function appendRunLog(
  runId: string,
  entry: RapidMapLogEntry
): Promise<Prisma.InputJsonArray> {
  const run = await prisma.rapidMapRun.findUnique({
    where: { id: runId },
    select: { processingLog: true },
  });

  return [...normalizeProcessingLog(run?.processingLog ?? null), entry];
}

async function updateRunState(
  runId: string,
  data: Prisma.RapidMapRunUpdateInput,
  logEntry: RapidMapLogEntry
) {
  const processingLog = await appendRunLog(runId, logEntry);
  return prisma.rapidMapRun.update({
    where: { id: runId },
    data: {
      ...data,
      processingLog,
    },
  });
}

async function setProgress(
  runId: string,
  progress: number,
  reportProgress?: RapidMapProgressReporter
) {
  await prisma.rapidMapRun.update({
    where: { id: runId },
    data: { progress },
  });

  await reportProgress?.(progress);
}

function parseSourceAssetIds(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isImageKey(key: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(key).toLowerCase());
}

async function buildSourceSpec(run: {
  sourceType: RapidMapSourceType;
  sourcePath: string | null;
  sourceAssetIds: Prisma.JsonValue | null;
}): Promise<RapidMapSourceSpec> {
  if (run.sourceType === "S3_PREFIX") {
    if (!run.sourcePath) {
      throw new Error("Rapid Map run is missing an S3 source prefix.");
    }

    assertValidS3Key(run.sourcePath, "Rapid Map source prefix");
    const objects = await S3Service.listObjects(run.sourcePath, 1000);
    const imageCount = objects.filter(isImageKey).length;

    return {
      type: run.sourceType,
      sourcePath: run.sourcePath,
      sourceBucket: S3Service.bucketName,
      sourceAssetIds: [],
      estimatedSourceImageCount: imageCount,
    };
  }

  if (run.sourceType === "ASSET_SET") {
    const sourceAssetIds = parseSourceAssetIds(run.sourceAssetIds);
    if (sourceAssetIds.length === 0) {
      throw new Error("Rapid Map run is missing source asset ids.");
    }

    return {
      type: run.sourceType,
      sourcePath: run.sourcePath,
      sourceAssetIds,
      estimatedSourceImageCount: sourceAssetIds.length,
    };
  }

  if (!run.sourcePath) {
    throw new Error("Rapid Map run is missing a processing-node source path.");
  }

  return {
    type: run.sourceType,
    sourcePath: run.sourcePath,
    sourceAssetIds: [],
  };
}

function safeRelativeArtifactPath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);

  if (parts.length === 0 || parts.some((part) => part === "." || part === "..")) {
    throw new Error(`Invalid Rapid Map artifact path: ${value}`);
  }

  return parts.join("/");
}

function contentTypeForArtifact(filePath: string, artifact: RapidMapRunnerArtifact): string {
  if (artifact.contentType) {
    return artifact.contentType;
  }

  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".json") return "application/json";
  if (extension === ".csv") return "text/csv; charset=utf-8";
  if (extension === ".tif" || extension === ".tiff") return "image/tiff";
  return "application/octet-stream";
}

async function uploadArtifactFile(options: {
  artifact: RapidMapRunnerArtifact;
  outputDirectory: string;
  outputS3Prefix: string;
  bucket: string;
}): Promise<UploadedRapidMapArtifact> {
  const relativePath = safeRelativeArtifactPath(options.artifact.path);
  const sourcePath = path.resolve(options.outputDirectory, relativePath);
  const outputRoot = path.resolve(options.outputDirectory);

  if (!sourcePath.startsWith(`${outputRoot}${path.sep}`) && sourcePath !== outputRoot) {
    throw new Error(`Rapid Map artifact escapes output directory: ${options.artifact.path}`);
  }

  const artifactStat = await stat(sourcePath);
  const targetRelativePath = safeRelativeArtifactPath(
    options.artifact.targetKey || relativePath
  );
  const s3Key = `${options.outputS3Prefix}/${targetRelativePath}`;
  assertValidS3Key(s3Key, "Rapid Map artifact key");

  await s3Client.send(
    new PutObjectCommand({
      Bucket: options.bucket,
      Key: s3Key,
      Body: createReadStream(sourcePath),
      ContentType: contentTypeForArtifact(sourcePath, options.artifact),
    })
  );

  return {
    ...options.artifact,
    path: relativePath,
    targetKey: targetRelativePath,
    s3Key,
    bucket: options.bucket,
    fileSize: artifactStat.size,
  };
}

async function uploadArtifacts(options: {
  manifest: RapidMapRunnerManifest;
  outputDirectory: string;
  outputS3Prefix: string;
  bucket: string;
}): Promise<UploadedRapidMapArtifact[]> {
  const artifacts = options.manifest.artifacts || [];

  return Promise.all(
    artifacts.map((artifact) =>
      uploadArtifactFile({
        artifact,
        outputDirectory: options.outputDirectory,
        outputS3Prefix: options.outputS3Prefix,
        bucket: options.bucket,
      })
    )
  );
}

function asJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toOptionalDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function pickOrthomosaicArtifact(
  artifacts: UploadedRapidMapArtifact[]
): UploadedRapidMapArtifact | undefined {
  return (
    artifacts.find((artifact) => artifact.role === "geotiff") ||
    artifacts.find((artifact) => {
      const extension = path.extname(artifact.path).toLowerCase();
      return extension === ".tif" || extension === ".tiff";
    })
  );
}

async function createOrthomosaicFromManifest(options: {
  runId: string;
  projectId: string;
  manifest: RapidMapRunnerManifest;
  artifacts: UploadedRapidMapArtifact[];
}): Promise<string | undefined> {
  const orthomosaic = options.manifest.orthomosaic;
  const artifact = pickOrthomosaicArtifact(options.artifacts);

  if (!orthomosaic || !artifact) {
    return undefined;
  }

  if (
    typeof orthomosaic.centerLat !== "number" ||
    typeof orthomosaic.centerLon !== "number" ||
    !orthomosaic.bounds
  ) {
    throw new Error(
      "Rapid Map manifest includes an orthomosaic but is missing bounds or center coordinates."
    );
  }

  const created = await prisma.orthomosaic.create({
    data: {
      projectId: options.projectId,
      name: orthomosaic.name || `Rapid Map ${options.runId.slice(0, 8)}`,
      description: orthomosaic.description || "Generated by Rapid Map processing",
      originalFile: artifact.s3Key,
      fileSize: BigInt(artifact.fileSize),
      s3Key: artifact.s3Key,
      s3Bucket: artifact.bucket,
      storageType: "s3",
      bounds: asJsonValue(orthomosaic.bounds),
      centerLat: orthomosaic.centerLat,
      centerLon: orthomosaic.centerLon,
      minZoom: orthomosaic.minZoom ?? 10,
      maxZoom: orthomosaic.maxZoom ?? 22,
      captureDate: toOptionalDate(orthomosaic.captureDate),
      resolution: orthomosaic.resolutionCmPerPixel,
      area: orthomosaic.areaHectares,
      imageCount: orthomosaic.imageCount,
      status: "COMPLETED",
      processingLog: [
        buildLogEntry("RAPID_MAP_LINKED", "Orthomosaic created from Rapid Map run", {
          rapidMapRunId: options.runId,
          artifactKey: artifact.s3Key,
        }),
      ],
    },
  });

  return created.id;
}

function buildOutputS3Prefix(run: {
  outputS3Prefix: string | null;
  projectId: string;
  id: string;
}): string {
  return (
    run.outputS3Prefix ||
    `${S3Service.environmentSegment}/${run.projectId}/rapid-maps/${run.id}`
  );
}

async function writeRunnerJobFile(options: {
  run: {
    id: string;
    teamId: string;
    projectId: string;
    name: string;
    description: string | null;
    preset: string;
    config: Prisma.JsonValue | null;
    outputBucket: string | null;
  };
  source: RapidMapSourceSpec;
  outputS3Prefix: string;
  outputDirectory: string;
}) {
  const jobFilePath = path.join(options.outputDirectory, "rapid-map-job.json");
  const jobSpec = {
    version: 1,
    runId: options.run.id,
    teamId: options.run.teamId,
    projectId: options.run.projectId,
    name: options.run.name,
    description: options.run.description,
    preset: options.run.preset,
    config: options.run.config || {},
    source: options.source,
    output: {
      bucket: options.run.outputBucket || S3Service.bucketName,
      prefix: options.outputS3Prefix,
      directory: options.outputDirectory,
      manifestPath: path.join(options.outputDirectory, "manifest.json"),
    },
  };

  await writeFile(jobFilePath, JSON.stringify(jobSpec, null, 2));
  return jobFilePath;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildCompletionSummary(
  manifest: RapidMapRunnerManifest,
  artifacts: UploadedRapidMapArtifact[]
): Prisma.InputJsonObject {
  return {
    ...(manifest.summary ? (asJsonValue(manifest.summary) as Prisma.InputJsonObject) : {}),
    artifactCount: artifacts.length,
    artifactsUploadedAt: new Date().toISOString(),
  };
}

export async function processRapidMapRun(
  runId: string,
  options: ProcessRapidMapRunOptions = {}
): Promise<RapidMapJobResult> {
  const run = await prisma.rapidMapRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      teamId: true,
      projectId: true,
      name: true,
      description: true,
      sourceType: true,
      sourcePath: true,
      sourceAssetIds: true,
      preset: true,
      status: true,
      config: true,
      outputS3Prefix: true,
      outputBucket: true,
    },
  });

  if (!run) {
    throw new Error(`Rapid Map run not found: ${runId}`);
  }

  if (run.status === RapidMapRunStatus.CANCELLED) {
    throw new Error(`Rapid Map run is cancelled: ${runId}`);
  }

  if (run.status === RapidMapRunStatus.COMPLETED) {
    return {
      runId,
      storageType: "s3",
    };
  }

  const outputS3Prefix = buildOutputS3Prefix(run);
  const outputBucket = run.outputBucket || S3Service.bucketName;
  let workDirectory: string | undefined;

  try {
    await updateRunState(
      runId,
      {
        status: RapidMapRunStatus.PROCESSING,
        progress: 5,
        startedAt: new Date(),
        completedAt: null,
        errorMessage: null,
        outputS3Prefix,
        outputBucket,
      },
      buildLogEntry("PROCESSING_STARTED", "Rapid Map worker started", {
        outputS3Prefix,
        outputBucket,
      })
    );
    await options.reportProgress?.(5);

    if (!process.env.RAPID_MAP_RUNNER_COMMAND) {
      throw new RapidMapRunnerNotConfiguredError();
    }

    const source = await buildSourceSpec(run);
    await setProgress(runId, 15, options.reportProgress);

    workDirectory = await mkdtemp(path.join(os.tmpdir(), `rapid-map-${runId}-`));
    const outputDirectory = path.join(workDirectory, "output");
    await mkdir(outputDirectory, { recursive: true });

    const jobFilePath = await writeRunnerJobFile({
      run,
      source,
      outputS3Prefix,
      outputDirectory,
    });

    await updateRunState(
      runId,
      {
        sourceImageCount: source.estimatedSourceImageCount,
        config: asJsonValue({
          ...(run.config && typeof run.config === "object" ? run.config : {}),
          worker: {
            jobFilePath,
            outputDirectory,
            source,
          },
        }),
      },
      buildLogEntry("RUNNER_DISPATCHED", "Rapid Map runner command dispatched")
    );
    await setProgress(runId, 30, options.reportProgress);

    const manifest = await runRapidMapRunner({
      runId,
      jobFilePath,
      outputDirectory,
    });
    await setProgress(runId, 70, options.reportProgress);

    const uploadedArtifacts = await uploadArtifacts({
      manifest,
      outputDirectory,
      outputS3Prefix,
      bucket: outputBucket,
    });
    await setProgress(runId, 85, options.reportProgress);

    const orthomosaicId = await createOrthomosaicFromManifest({
      runId,
      projectId: run.projectId,
      manifest,
      artifacts: uploadedArtifacts,
    });

    const summary = manifest.summary || {};
    const artifactManifest = {
      version: manifest.version || 1,
      artifacts: uploadedArtifacts,
      orthomosaic: manifest.orthomosaic || null,
    };

    await updateRunState(
      runId,
      {
        status: RapidMapRunStatus.COMPLETED,
        progress: 100,
        completedAt: new Date(),
        orthomosaic: orthomosaicId
          ? {
              connect: { id: orthomosaicId },
            }
          : undefined,
        artifactManifest: asJsonValue(artifactManifest),
        runSummary: buildCompletionSummary(manifest, uploadedArtifacts),
        sourceImageCount:
          numberOrUndefined(summary.sourceImageCount) ||
          source.estimatedSourceImageCount,
        renderedImageCount: numberOrUndefined(summary.renderedImageCount),
        excludedImageCount: numberOrUndefined(summary.excludedImageCount),
        estimatedErrorMeters: numberOrUndefined(summary.estimatedErrorMeters),
      },
      buildLogEntry("COMPLETED", "Rapid Map run completed", {
        artifactCount: uploadedArtifacts.length,
        orthomosaicId: orthomosaicId || null,
      })
    );
    await options.reportProgress?.(100);

    return {
      runId,
      orthomosaicId,
      sourceImageCount:
        numberOrUndefined(summary.sourceImageCount) ||
        source.estimatedSourceImageCount,
      renderedImageCount: numberOrUndefined(summary.renderedImageCount),
      excludedImageCount: numberOrUndefined(summary.excludedImageCount),
      artifactCount: uploadedArtifacts.length,
      storageType: "s3",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Rapid Map error";

    await updateRunState(
      runId,
      {
        status: RapidMapRunStatus.FAILED,
        completedAt: new Date(),
        errorMessage: message.slice(0, 1000),
      },
      buildLogEntry("FAILED", "Rapid Map run failed", {
        error: message.slice(0, 1000),
      })
    );

    throw error;
  } finally {
    if (workDirectory && process.env.RAPID_MAP_KEEP_WORKDIR !== "1") {
      await rm(workDirectory, { recursive: true, force: true });
    }
  }
}
