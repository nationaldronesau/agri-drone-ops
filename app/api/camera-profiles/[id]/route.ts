import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getAuthenticatedUser, getUserTeamMemberships, canManageTeam } from "@/lib/auth/api-auth";

const toOptionalNumber = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.cameraProfile.findUnique({
      where: { id: params.id },
      select: { id: true, teamId: true },
    });

    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (!canManageTeam(memberships.memberships, profile.teamId)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : undefined;
    const description = typeof body.description === "string" ? body.description.trim() : undefined;

    const fov = toOptionalNumber(body.fov);
    const calibratedFocalLength = toOptionalNumber(body.calibratedFocalLength);
    const opticalCenterX = toOptionalNumber(body.opticalCenterX);
    const opticalCenterY = toOptionalNumber(body.opticalCenterY);

    const updated = await prisma.cameraProfile.update({
      where: { id: profile.id },
      data: {
        ...(name ? { name } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(fov !== null ? { fov } : {}),
        ...(calibratedFocalLength !== null ? { calibratedFocalLength } : {}),
        ...(opticalCenterX !== null ? { opticalCenterX } : {}),
        ...(opticalCenterY !== null ? { opticalCenterY } : {}),
      },
    });

    return NextResponse.json({ profile: updated });
  } catch (error) {
    console.error("Failed to update camera profile:", error);
    return NextResponse.json({ error: "Failed to update camera profile" }, { status: 500 });
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.cameraProfile.findUnique({
      where: { id: params.id },
      select: { id: true, teamId: true },
    });

    if (!profile) {
      return NextResponse.json({ error: "Profile not found" }, { status: 404 });
    }

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (!canManageTeam(memberships.memberships, profile.teamId)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    await prisma.cameraProfile.delete({ where: { id: profile.id } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Failed to delete camera profile:", error);
    return NextResponse.json({ error: "Failed to delete camera profile" }, { status: 500 });
  }
}
