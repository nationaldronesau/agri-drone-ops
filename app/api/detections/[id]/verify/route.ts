import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { z } from "zod";
import { logAudit } from "@/lib/utils/audit";

const bodySchema = z.object({
  verified: z.boolean().optional().default(true),
  className: z.string().optional(),
  boundingBox: z
    .object({
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
    })
    .optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await request.json();
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

    const updates: Record<string, unknown> = {
      verified: parsed.data.verified ?? true,
      rejected: false,
      reviewedAt: new Date(),
    };

    if (parsed.data.className && parsed.data.className !== existing.className) {
      updates.originalClass = existing.originalClass || existing.className;
      updates.className = parsed.data.className;
      updates.userCorrected = true;
    }

    if (parsed.data.boundingBox) {
      updates.boundingBox = parsed.data.boundingBox;
      updates.userCorrected = true;
    }

    const detection = await prisma.detection.update({
      where: { id: params.id },
      data: updates,
    });

    // Log verification action for audit trail
    await logAudit({
      action: parsed.data.verified ? 'VERIFY' : 'UNVERIFY',
      entityType: 'Detection',
      entityId: params.id,
      beforeState: {
        verified: existing.verified,
        className: existing.className,
        boundingBox: existing.boundingBox,
      },
      afterState: {
        verified: detection.verified,
        className: detection.className,
        boundingBox: detection.boundingBox,
        userCorrected: detection.userCorrected,
      },
      request,
    });

    return NextResponse.json({ success: true, detection });
  } catch (error) {
    console.error("Error verifying detection:", error);
    return NextResponse.json(
      { error: "Failed to verify detection" },
      { status: 500 },
    );
  }
}
