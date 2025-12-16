import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";
import { isAuthBypassed } from "@/lib/utils/auth-bypass";
import { z } from "zod";

const requestSchema = z.object({
  annotationIds: z.array(z.string().min(1)).min(1, "annotationIds is required"),
  split: z.enum(["train", "valid", "test"]).optional(),
});

export async function POST(request: NextRequest) {
  try {
    // Auth check with explicit bypass for development
    if (!isAuthBypassed()) {
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

    const { annotationIds, split } = parsed.data;
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
