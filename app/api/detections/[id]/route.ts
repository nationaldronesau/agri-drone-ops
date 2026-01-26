import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/auth/api-auth";
import { isAuthBypassed } from "@/lib/utils/auth-bypass";

const updateSchema = z.object({
  verified: z.boolean().optional(),
  rejected: z.boolean().optional(),
  className: z.string().optional(),
  userCorrected: z.boolean().optional(),
  originalClass: z.string().nullable().optional(),
});

// Helper to check if user has access to a detection via team membership
async function checkDetectionAccess(detectionId: string, userId: string): Promise<boolean> {
  const detection = await prisma.detection.findFirst({
    where: {
      id: detectionId,
      asset: {
        project: {
          team: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    },
  });
  return !!detection;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Skip auth check only when explicitly bypassed
    const bypassAuth = isAuthBypassed();
    let userId: string | null = null;

    if (!bypassAuth) {
      const auth = await getAuthenticatedUser();
      if (!auth.authenticated || !auth.userId) {
        return NextResponse.json(
          { error: auth.error || "Unauthorized" },
          { status: 401 },
        );
      }
      userId = auth.userId;
    }

    const { id } = await params;

    // When auth is enforced, verify user has access to this detection
    if (!bypassAuth && userId) {
      const hasAccess = await checkDetectionAccess(id, userId);
      if (!hasAccess) {
        return NextResponse.json(
          { error: "Detection not found or access denied" },
          { status: 403 },
        );
      }
    }

    const detection = await prisma.detection.findUnique({
      where: { id },
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            storageUrl: true,
            gpsLatitude: true,
            gpsLongitude: true,
            altitude: true,
            imageWidth: true,
            imageHeight: true,
          },
        },
        job: true,
      },
    });

    if (!detection) {
      return NextResponse.json(
        { error: "Detection not found" },
        { status: 404 },
      );
    }

    return NextResponse.json(detection);
  } catch (error) {
    console.error("Error fetching detection:", error);
    return NextResponse.json(
      { error: "Failed to fetch detection" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Skip auth check only when explicitly bypassed
    const bypassAuth = isAuthBypassed();
    let userId: string | null = null;

    if (!bypassAuth) {
      const auth = await getAuthenticatedUser();
      if (!auth.authenticated || !auth.userId) {
        return NextResponse.json(
          { error: auth.error || "Unauthorized" },
          { status: 401 },
        );
      }
      userId = auth.userId;
    }

    const { id } = await params;

    // When auth is enforced, verify user has access to this detection
    if (!bypassAuth && userId) {
      const hasAccess = await checkDetectionAccess(id, userId);
      if (!hasAccess) {
        return NextResponse.json(
          { error: "Detection not found or access denied" },
          { status: 403 },
        );
      }
    }

    const body = await request.json();
    const parsed = updateSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const existing = await prisma.detection.findUnique({
      where: { id },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Detection not found" },
        { status: 404 },
      );
    }

    const updates: Record<string, unknown> = {
      reviewedAt: new Date(),
    };

    if (parsed.data.verified !== undefined) {
      updates.verified = parsed.data.verified;
    }
    if (parsed.data.rejected !== undefined) {
      updates.rejected = parsed.data.rejected;
    }
    if (parsed.data.className !== undefined) {
      updates.className = parsed.data.className;
    }
    if (parsed.data.userCorrected !== undefined) {
      updates.userCorrected = parsed.data.userCorrected;
    }
    if (parsed.data.originalClass !== undefined) {
      updates.originalClass = parsed.data.originalClass;
    }

    const detection = await prisma.detection.update({
      where: { id },
      data: updates,
      include: {
        asset: {
          select: {
            id: true,
            fileName: true,
            storageUrl: true,
          },
        },
      },
    });

    return NextResponse.json(detection);
  } catch (error) {
    console.error("Error updating detection:", error);
    return NextResponse.json(
      { error: "Failed to update detection" },
      { status: 500 },
    );
  }
}
