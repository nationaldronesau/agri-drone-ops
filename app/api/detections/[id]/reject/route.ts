import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { z } from "zod";

const bodySchema = z.object({
  reason: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = bodySchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.detection.findUnique({
      where: { id: params.id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Detection not found" },
        { status: 404 },
      );
    }

    const updatedMetadata = {
      ...(existing.metadata || {}),
      rejectionReason: parsed.data.reason || null,
    };

    await prisma.detection.update({
      where: { id: params.id },
      data: {
        verified: false,
        rejected: true,
        reviewedAt: new Date(),
        metadata: updatedMetadata,
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error rejecting detection:", error);
    return NextResponse.json(
      { error: "Failed to reject detection" },
      { status: 500 },
    );
  }
}
