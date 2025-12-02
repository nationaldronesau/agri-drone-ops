import { NextRequest, NextResponse } from "next/server";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";

export async function GET(_request: NextRequest) {
  try {
    const result = await roboflowTrainingService.testConnection();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Roboflow training test failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
