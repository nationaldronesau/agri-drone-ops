import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";
import { isAuthBypassed } from "@/lib/utils/auth-bypass";
import prisma from "@/lib/db";
import { z } from "zod";

const requestSchema = z.object({
  annotationId: z.string().min(1, "annotationId is required"),
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

    const { annotationId, split } = parsed.data;

    // Authorization: verify user has access to this annotation's project
    if (!isAuthBypassed() && userId) {
      const annotation = await prisma.manualAnnotation.findUnique({
        where: { id: annotationId },
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

      if (!annotation) {
        return NextResponse.json({ error: "Annotation not found" }, { status: 404 });
      }

      const team = annotation.session.asset.project?.team;
      if (team) {
        const isMember = team.members.some((m) => m.userId === userId);
        if (!isMember) {
          return NextResponse.json(
            { error: "You do not have access to this annotation" },
            { status: 403 },
          );
        }
      }
    }

    const result = await roboflowTrainingService.uploadFromAnnotation(
      annotationId,
      split,
    );

    return NextResponse.json({
      success: true,
      roboflowId: result.id,
    });
  } catch (error) {
    console.error("Training upload error:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to upload training data. Please try again.",
      },
      { status: 500 },
    );
  }
}
