import { NextRequest, NextResponse } from "next/server";
import {
  Prisma,
  RapidMapPreset,
  RapidMapRunStatus,
  RapidMapSourceType,
} from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/db";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { enqueueRapidMapRun } from "@/lib/queue/rapid-map-queue";
import {
  RapidMapAssetSetValidationError,
  resolveRapidMapAssetSet,
} from "@/lib/services/rapid-map-asset-source";
import { assertRapidMapProjectS3Prefix } from "@/lib/services/rapid-map-source-path";
import { S3Service } from "@/lib/services/s3";

const createRapidMapRunSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    description: z.string().trim().max(2000).optional(),
    sourceType: z
      .nativeEnum(RapidMapSourceType)
      .optional()
      .default(RapidMapSourceType.S3_PREFIX),
    sourcePath: z.string().trim().min(1).max(4000).optional(),
    sourceAssetIds: z.array(z.string().min(1)).max(5000).optional(),
    preset: z
      .nativeEnum(RapidMapPreset)
      .optional()
      .default(RapidMapPreset.INITIAL_TRIAL),
  })
  .superRefine((value, context) => {
    if (value.sourceType === RapidMapSourceType.ASSET_SET) {
      if (!value.sourceAssetIds?.length) {
        context.addIssue({
          code: "custom",
          path: ["sourceAssetIds"],
          message: "ASSET_SET requires source asset ids.",
        });
      }
      return;
    }

    if (!value.sourcePath) {
      context.addIssue({
        code: "custom",
        path: ["sourcePath"],
        message: `${value.sourceType} requires a source path.`,
      });
    }
  });

function presetConfig(preset: RapidMapPreset): Prisma.InputJsonObject {
  switch (preset) {
    case RapidMapPreset.SHARPER_REVIEW:
      return {
        pixelSizeM: 0.2,
        featherPx: 24,
        maxSourcePx: 1536,
        nadirPitchToleranceDeg: 15,
        targetEpsg: "auto",
        dem: "auto",
        blend: "center",
        cog: true,
      };
    case RapidMapPreset.COVERAGE_CHECK:
      return {
        pixelSizeM: 0.5,
        featherPx: 16,
        maxSourcePx: 768,
        nadirPitchToleranceDeg: 20,
        targetEpsg: "auto",
        dem: "auto",
        blend: "center",
        cog: true,
      };
    case RapidMapPreset.INITIAL_TRIAL:
    default:
      return {
        pixelSizeM: 0.3,
        featherPx: 32,
        maxSourcePx: 1024,
        nadirPitchToleranceDeg: 15,
        targetEpsg: "auto",
        dem: "auto",
        blend: "center",
        cog: true,
      };
  }
}

function processingLog(
  stage: string,
  message: string,
  details?: Prisma.InputJsonObject
): Prisma.InputJsonObject {
  return {
    stage,
    message,
    timestamp: new Date().toISOString(),
    ...(details ? { details } : {}),
  };
}

function appendProcessingLog(
  current: Prisma.JsonValue | null,
  entry: Prisma.InputJsonObject
): Prisma.InputJsonArray {
  const existing = Array.isArray(current)
    ? (current.filter(Boolean) as Prisma.InputJsonArray)
    : current && typeof current === "object"
      ? [current as Prisma.InputJsonObject]
      : [];

  return [...existing, entry];
}

function buildOutputPrefix(projectId: string, runId: string): string {
  return `${S3Service.environmentSegment}/${projectId}/rapid-maps/${runId}`;
}

function serializeRapidMapRun<T extends { createdAt: Date; updatedAt: Date; startedAt: Date | null; completedAt: Date | null }>(
  run: T
) {
  return {
    ...run,
    createdAt: run.createdAt.toISOString(),
    updatedAt: run.updatedAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || "Access denied" }, { status: 403 });
    }

    const status = request.nextUrl.searchParams.get("status");
    const limit = Math.max(1, Math.min(100, Number(request.nextUrl.searchParams.get("limit") || "20")));
    const offset = Math.max(0, Number(request.nextUrl.searchParams.get("offset") || "0"));

    const where: Prisma.RapidMapRunWhereInput = {
      teamId: access.teamId,
      projectId,
    };

    if (status && Object.values(RapidMapRunStatus).includes(status as RapidMapRunStatus)) {
      where.status = status as RapidMapRunStatus;
    }

    const [runs, total] = await Promise.all([
      prisma.rapidMapRun.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
        include: {
          orthomosaic: {
            select: {
              id: true,
              name: true,
              status: true,
              tilesetPath: true,
              s3TilesetKey: true,
            },
          },
        },
      }),
      prisma.rapidMapRun.count({ where }),
    ]);

    return NextResponse.json({
      runs: runs.map((run) => serializeRapidMapRun(run)),
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error("Failed to list rapid map runs:", error);
    return NextResponse.json({ error: "Failed to list rapid map runs" }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const { id: projectId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || "Access denied" }, { status: 403 });
    }

    const payload = createRapidMapRunSchema.safeParse(await request.json().catch(() => ({})));
    if (!payload.success) {
      return NextResponse.json(
        { error: "Invalid request body", details: payload.error.flatten() },
        { status: 400 }
      );
    }

    if (payload.data.sourceType === RapidMapSourceType.S3_PREFIX) {
      try {
        assertRapidMapProjectS3Prefix(payload.data.sourcePath!, projectId);
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Rapid Map S3 source prefix is invalid.",
          },
          { status: 400 }
        );
      }
    }

    if (payload.data.sourceType === RapidMapSourceType.ASSET_SET) {
      await resolveRapidMapAssetSet(
        access.teamId,
        payload.data.sourceAssetIds || []
      );
    }

    const runName =
      payload.data.name ||
      `Rapid Map - ${new Date().toLocaleDateString("en-AU", {
        day: "2-digit",
        month: "short",
        year: "numeric",
      })}`;

    let run = await prisma.rapidMapRun.create({
      data: {
        teamId: access.teamId,
        projectId,
        createdById: auth.userId,
        name: runName,
        description: payload.data.description,
        sourceType: payload.data.sourceType,
        sourcePath: payload.data.sourcePath ?? null,
        sourceAssetIds: payload.data.sourceAssetIds
          ? (payload.data.sourceAssetIds as Prisma.InputJsonArray)
          : Prisma.DbNull,
        preset: payload.data.preset,
        status: RapidMapRunStatus.QUEUED,
        progress: 0,
        config: {
          preset: payload.data.preset,
          sourceType: payload.data.sourceType,
          runner: "flat-map-runner",
          outputPrefixPattern: "{env}/{projectId}/rapid-maps/{runId}",
          ...presetConfig(payload.data.preset),
        },
        outputS3Prefix: "",
        outputBucket: S3Service.bucketName,
        processingLog: processingLog(
          "RECORDED",
          "Rapid Map run recorded. Background processing is waiting to start."
        ),
      },
    });

    const outputS3Prefix = buildOutputPrefix(projectId, run.id);
    run = await prisma.rapidMapRun.update({
      where: { id: run.id },
      data: { outputS3Prefix },
    });

    await prisma.auditLog.create({
      data: {
        action: "CREATE",
        entityType: "RapidMapRun",
        entityId: run.id,
        userId: auth.userId,
        beforeState: Prisma.JsonNull,
        afterState: {
          status: run.status,
          projectId,
          sourceType: payload.data.sourceType,
          sourcePath: payload.data.sourcePath ?? null,
          preset: payload.data.preset,
          outputS3Prefix,
        } as Prisma.InputJsonValue,
      },
    });

    let queued = false;
    let queueError: string | null = null;

    try {
      const queueJobId = await enqueueRapidMapRun({
        runId: run.id,
        projectId,
        teamId: access.teamId,
      });

      queued = true;
      run = await prisma.rapidMapRun.update({
        where: { id: run.id },
        data: {
          queueJobId,
          processingLog: appendProcessingLog(
            run.processingLog,
            processingLog("QUEUED", "Rapid Map processing has been queued.")
          ),
        },
      });
    } catch (error) {
      queueError =
        error instanceof Error
          ? error.message
          : "Rapid Map processing could not be queued.";

      run = await prisma.rapidMapRun.update({
        where: { id: run.id },
        data: {
          errorMessage: queueError,
          processingLog: appendProcessingLog(
            run.processingLog,
            processingLog(
              "QUEUE_UNAVAILABLE",
              "Rapid Map run was recorded, but the processing queue is not available yet.",
              { error: queueError }
            )
          ),
        },
      });
    }

    return NextResponse.json(
      {
        success: true,
        queued,
        queueError,
        run: serializeRapidMapRun(run),
      },
      { status: 202 }
    );
  } catch (error) {
    if (error instanceof RapidMapAssetSetValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    console.error("Failed to create rapid map run:", error);
    return NextResponse.json({ error: "Failed to create rapid map run" }, { status: 500 });
  }
}
