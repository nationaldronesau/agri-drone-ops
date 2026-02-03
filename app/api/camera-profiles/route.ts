import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import {
  getAuthenticatedUser,
  getUserTeamIds,
  getUserTeamMemberships,
  canManageTeam,
} from "@/lib/auth/api-auth";

const toOptionalNumber = (value: unknown): number | null => {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (membership.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    const teamIds = membership.teamIds;
    if (teamIds.length === 0) {
      return NextResponse.json({ profiles: [] });
    }

    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get("teamId");
    if (teamId && !teamIds.includes(teamId)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const profiles = await prisma.cameraProfile.findMany({
      where: {
        teamId: teamId ? teamId : { in: teamIds },
      },
      include: {
        team: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ profiles });
  } catch (error) {
    console.error("Failed to fetch camera profiles:", error);
    return NextResponse.json({ error: "Failed to fetch camera profiles" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : null;
    const teamId = typeof body.teamId === "string" ? body.teamId : null;

    if (!name) {
      return NextResponse.json({ error: "Profile name is required" }, { status: 400 });
    }

    const fov = toOptionalNumber(body.fov);
    const calibratedFocalLength = toOptionalNumber(body.calibratedFocalLength);
    const opticalCenterX = toOptionalNumber(body.opticalCenterX);
    const opticalCenterY = toOptionalNumber(body.opticalCenterY);

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    let targetTeamId = teamId;
    if (targetTeamId) {
      if (!canManageTeam(memberships.memberships, targetTeamId)) {
        return NextResponse.json({ error: "Access denied" }, { status: 403 });
      }
    } else {
      const managedTeam = memberships.memberships.find(
        (m) => m.role === "OWNER" || m.role === "ADMIN"
      );
      if (!managedTeam) {
        return NextResponse.json(
          { error: "No team available to create profile" },
          { status: 400 }
        );
      }
      targetTeamId = managedTeam.teamId;
    }

    const profile = await prisma.cameraProfile.create({
      data: {
        teamId: targetTeamId,
        name,
        description,
        fov,
        calibratedFocalLength,
        opticalCenterX,
        opticalCenterY,
      },
    });

    return NextResponse.json({ profile });
  } catch (error) {
    console.error("Failed to create camera profile:", error);
    return NextResponse.json({ error: "Failed to create camera profile" }, { status: 500 });
  }
}
