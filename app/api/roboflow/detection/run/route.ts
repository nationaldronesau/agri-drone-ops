import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/db";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { checkRedisConnection } from "@/lib/queue/redis";
import {
  enqueueRoboflowDetectionJob,
  type RoboflowDynamicModelConfig,
} from "@/lib/queue/roboflow-detection-queue";
import {
  ROBOFLOW_MODELS,
  roboflowService,
  type ModelType,
} from "@/lib/services/roboflow";

const dynamicModelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  version: z.number(),
  endpoint: z.string(),
  classes: z.array(z.string()),
});

const requestSchema = z.object({
  projectId: z.string().min(1, "projectId is required"),
  assetIds: z.array(z.string()).min(1, "assetIds must not be empty"),
  dynamicModels: z.array(dynamicModelSchema).optional().default([]),
  detectionModels: z.array(z.string()).optional().default([]),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { projectId, dynamicModels, detectionModels } = parsed.data;
    const assetIds = [...new Set(parsed.data.assetIds)];

    const projectAccess = await checkProjectAccess(projectId);
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || "Access denied" },
        { status: 403 }
      );
    }

    const assetCount = await prisma.asset.count({
      where: {
        id: { in: assetIds },
        projectId,
      },
    });

    if (assetCount !== assetIds.length) {
      return NextResponse.json(
        { error: "One or more assetIds do not belong to this project" },
        { status: 400 }
      );
    }

    const requestedModels = detectionModels.filter(
      (model): model is ModelType => model in ROBOFLOW_MODELS
    );
    const useDynamicModels = dynamicModels.length > 0;
    const modelsToRun = requestedModels.length > 0
      ? requestedModels
      : (roboflowService.getEnabledModels() as ModelType[]);

    if (!useDynamicModels && modelsToRun.length === 0) {
      return NextResponse.json(
        { error: "No enabled Roboflow models are available for detection" },
        { status: 400 }
      );
    }

    const skippedImages = await prisma.asset.count({
      where: {
        id: { in: assetIds },
        projectId,
        OR: [
          { gpsLatitude: null },
          { gpsLongitude: null },
          { imageWidth: null },
          { imageHeight: null },
        ],
      },
    });

    const assetsToProcess = await prisma.asset.findMany({
      where: {
        id: { in: assetIds },
        projectId,
        gpsLatitude: { not: null },
        gpsLongitude: { not: null },
        imageWidth: { not: null },
        imageHeight: { not: null },
      },
      select: { id: true },
    });

    const eligibleAssetIds = assetsToProcess.map((asset) => asset.id);
    if (eligibleAssetIds.length === 0) {
      return NextResponse.json(
        {
          error: "No eligible images to process",
          totalImages: 0,
          skippedImages,
        },
        { status: 400 }
      );
    }

    const redisAvailable = await checkRedisConnection();
    if (!redisAvailable) {
      return NextResponse.json(
        { error: "Redis unavailable - background Roboflow detection cannot be queued." },
        { status: 503 }
      );
    }

    const processingJob = await prisma.processingJob.create({
      data: {
        projectId,
        type: "AI_DETECTION",
        status: "PENDING",
        progress: 0,
        config: {
          source: "roboflow_batch_detection",
          modelSource: useDynamicModels ? "dynamic" : "legacy",
          modelNames: useDynamicModels
            ? dynamicModels.map((model) => model.projectName)
            : modelsToRun.map((model) => ROBOFLOW_MODELS[model].name),
          totalImages: eligibleAssetIds.length,
          processedImages: 0,
          detectionsFound: 0,
          skippedImages,
          duplicateImages: 0,
        },
      },
    });

    await enqueueRoboflowDetectionJob({
      processingJobId: processingJob.id,
      projectId,
      assetIds: eligibleAssetIds,
      dynamicModels: useDynamicModels
        ? (dynamicModels as RoboflowDynamicModelConfig[])
        : undefined,
      detectionModels: useDynamicModels ? undefined : modelsToRun,
    });

    return NextResponse.json({
      jobId: processingJob.id,
      totalImages: eligibleAssetIds.length,
      skippedImages,
      status: "queued",
      source: "roboflow_batch_detection",
    });
  } catch (error) {
    console.error("Error starting background Roboflow detection:", error);
    return NextResponse.json(
      { error: "Failed to start background Roboflow detection" },
      { status: 500 }
    );
  }
}
