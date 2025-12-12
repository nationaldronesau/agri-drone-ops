import { NextRequest, NextResponse } from "next/server";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";

export async function GET(_request: NextRequest) {
  try {
    const result = await roboflowTrainingService.testConnection();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Training service test failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(
      {
        success: false,
        error: "Training service connection test failed. Please check configuration.",
      },
      { status: 500 },
    );
  }
}
