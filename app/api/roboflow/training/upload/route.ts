import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";
import { z } from "zod";

const requestSchema = z.object({
  annotationId: z.string().min(1, "annotationId is required"),
  split: z.enum(["train", "valid", "test"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Skip auth check in development mode (auth is disabled)
    const isDev = process.env.NODE_ENV === "development";
    if (!isDev) {
      const session = await getServerSession(authOptions);
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
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
