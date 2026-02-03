import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getAuthenticatedUser, getUserTeamMemberships, canManageTeam } from "@/lib/auth/api-auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: { projectId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const project = await prisma.project.findUnique({
      where: { id: params.projectId },
      select: { id: true, teamId: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const memberships = await getUserTeamMemberships();
    if (memberships.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (!canManageTeam(memberships.memberships, project.teamId)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const cameraProfileId =
      typeof body.cameraProfileId === "string" && body.cameraProfileId.trim().length > 0
        ? body.cameraProfileId
        : null;

    if (cameraProfileId) {
      const profile = await prisma.cameraProfile.findFirst({
        where: { id: cameraProfileId, teamId: project.teamId },
        select: { id: true },
      });
      if (!profile) {
        return NextResponse.json({ error: "Camera profile not found" }, { status: 400 });
      }
    }

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        cameraProfileId,
      },
      include: {
        _count: { select: { assets: true } },
        cameraProfile: { select: { id: true, name: true } },
      },
    });

    return NextResponse.json({ project: updated });
  } catch (error) {
    console.error("Failed to update project:", error);
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}
