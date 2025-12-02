import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";

export async function GET(_request: NextRequest) {
  try {
    const totalVerified = await prisma.manualAnnotation.count({
      where: { verified: true },
    });

    const pushedToTraining = await prisma.manualAnnotation.count({
      where: { verified: true, pushedToTraining: true },
    });

    const byClass = await prisma.manualAnnotation.groupBy({
      by: ["weedType"],
      where: { verified: true },
      _count: { weedType: true },
    });

    const pendingPush = totalVerified - pushedToTraining;

    return NextResponse.json({
      totalVerified,
      pushedToTraining,
      pendingPush,
      byClass: byClass.reduce<Record<string, number>>((acc, group) => {
        acc[group.weedType] = group._count.weedType || 0;
        return acc;
      }, {}),
    });
  } catch (error) {
    console.error("Roboflow stats error:", error);
    return NextResponse.json(
      { error: "Failed to fetch training stats" },
      { status: 500 },
    );
  }
}
