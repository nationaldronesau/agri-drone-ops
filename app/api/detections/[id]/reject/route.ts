import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { z } from "zod";
import { logAudit } from "@/lib/utils/audit";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";

const bodySchema = z.object({
  reason: z.string().optional(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 },
      );
    }

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
      include: {
        asset: {
          select: {
            projectId: true,
          },
        },
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Detection not found" },
        { status: 404 },
      );
    }

    const projectAuth = await checkProjectAccess(existing.asset.projectId);
    if (!projectAuth.hasAccess) {
      return NextResponse.json(
        { error: projectAuth.error || "Access denied" },
        { status: 403 },
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

    // Log rejection action for audit trail
    await logAudit({
      action: 'REJECT',
      entityType: 'Detection',
      entityId: params.id,
      beforeState: {
        verified: existing.verified,
        rejected: existing.rejected,
      },
      afterState: {
        verified: false,
        rejected: true,
        rejectionReason: parsed.data.reason || null,
      },
      request,
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
