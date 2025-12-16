import { NextRequest, NextResponse } from "next/server";
import { roboflowTrainingService } from "@/lib/services/roboflow-training";
import { blockInProduction } from "@/lib/utils/dev-only";

export async function GET(_request: NextRequest) {
  const prodBlock = blockInProduction();
  if (prodBlock) return prodBlock;

  try {
    const result = await roboflowTrainingService.testConnection();
    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Training service test failed:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Training service connection test failed. Please check configuration.",
      },
      { status: 500 },
    );
  }
}
