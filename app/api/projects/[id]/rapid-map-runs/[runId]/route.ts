import { NextResponse } from "next/server";
import prisma from "@/lib/db";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";

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
  _request: Request,
  { params }: { params: Promise<{ id: string; runId: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const { id: projectId, runId } = await params;
    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || "Access denied" }, { status: 403 });
    }

    const run = await prisma.rapidMapRun.findFirst({
      where: {
        id: runId,
        projectId,
        teamId: access.teamId,
      },
      include: {
        orthomosaic: {
          select: {
            id: true,
            name: true,
            status: true,
            tilesetPath: true,
            s3TilesetKey: true,
            bounds: true,
            centerLat: true,
            centerLon: true,
          },
        },
      },
    });

    if (!run) {
      return NextResponse.json({ error: "Rapid Map run not found" }, { status: 404 });
    }

    return NextResponse.json({ run: serializeRapidMapRun(run) });
  } catch (error) {
    console.error("Failed to fetch rapid map run:", error);
    return NextResponse.json({ error: "Failed to fetch rapid map run" }, { status: 500 });
  }
}
