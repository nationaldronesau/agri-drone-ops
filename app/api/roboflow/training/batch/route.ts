import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";
import { isAuthBypassed } from "@/lib/utils/auth-bypass";
import prisma from "@/lib/db";
import { z } from "zod";

const requestSchema = z.object({
  annotationIds: z.array(z.string().min(1)).min(1, "annotationIds is required"),
  split: z.enum(["train", "valid", "test"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Auth check with explicit bypass for development
    let userId: string | null = null;
    if (!isAuthBypassed()) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
      userId = session.user.id;
    }

    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { annotationIds, split } = parsed.data;

    // Authorization: verify user has access to all annotations
    if (!isAuthBypassed() && userId) {
      const annotations = await prisma.manualAnnotation.findMany({
        where: { id: { in: annotationIds } },
        include: {
          session: {
            include: {
              asset: {
                include: {
                  project: {
                    include: {
                      team: {
                        include: { members: true },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });

      // Check if any annotations are missing or user doesn't have access
      for (const annotation of annotations) {
        const team = annotation.session.asset.project?.team;
        if (team) {
          const isMember = team.members.some((m) => m.userId === userId);
          if (!isMember) {
            return NextResponse.json(
              { error: "You do not have access to one or more annotations" },
              { status: 403 },
            );
          }
        }
      }

      if (annotations.length !== annotationIds.length) {
        return NextResponse.json(
          { error: "One or more annotations not found" },
          { status: 404 },
        );
      }
    }

    const result = await roboflowTrainingService.uploadBatch(
      annotationIds,
      split,
    );

    return NextResponse.json({
      success: result.success,
      failed: result.failed,
      errors: result.errors,
    });
  } catch (error) {
    console.error("Training batch upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to upload batch training data. Please try again.",
      },
      { status: 500 },
    );
  }
}
