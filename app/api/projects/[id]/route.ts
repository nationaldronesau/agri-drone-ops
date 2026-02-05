import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import prisma from '@/lib/db';
import { getAuthenticatedUser, getUserTeamMemberships, canManageTeam } from "@/lib/auth/api-auth";

// Helper to verify user has access to project via team membership
async function verifyProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { teamId: true }
  });

  if (!project) return false;

  const membership = await prisma.teamMember.findFirst({
    where: {
      userId,
      teamId: project.teamId
    }
  });

  return !!membership;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Authorization check - verify user has access to this project
    const hasAccess = await verifyProjectAccess(session.user.id, id);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      );
    }

    const project = await prisma.project.findUnique({
      where: { id },
      include: {
        _count: {
          select: { assets: true }
        }
      }
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(project);
  } catch (error) {
    console.error('Failed to fetch project:', error);
    return NextResponse.json(
      { error: 'Failed to fetch project' },
      { status: 500 }
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Authorization check - verify user has access to this project
    const hasAccess = await verifyProjectAccess(session.user.id, id);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      );
    }

    const { name, description, location, purpose, season } = await request.json();

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(name && { name }),
        ...(description !== undefined && { description }),
        ...(location !== undefined && { location }),
        ...(purpose && { purpose }),
        ...(season !== undefined && { season }),
      },
      include: {
        _count: {
          select: { assets: true }
        }
      }
    });

    return NextResponse.json(project);
  } catch (error) {
    console.error('Failed to update project:', error);
    return NextResponse.json(
      { error: 'Failed to update project' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const { id } = await params;

    // Authorization check - verify user has access to this project
    const hasAccess = await verifyProjectAccess(session.user.id, id);
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 404 }
      );
    }

    await prisma.project.delete({
      where: { id }
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Failed to delete project:', error);
    return NextResponse.json(
      { error: 'Failed to delete project' },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    const project = await prisma.project.findUnique({
      where: { id },
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
    const activeModelId =
      typeof body.activeModelId === "string" && body.activeModelId.trim().length > 0
        ? body.activeModelId
        : null;
    const inferenceBackend =
      typeof body.inferenceBackend === "string" && body.inferenceBackend.trim().length > 0
        ? body.inferenceBackend
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

    if (activeModelId) {
      const model = await prisma.trainedModel.findFirst({
        where: { id: activeModelId, teamId: project.teamId },
        select: { id: true },
      });
      if (!model) {
        return NextResponse.json({ error: "Active model not found" }, { status: 400 });
      }
    }

    if (inferenceBackend) {
      const allowed = new Set(["LOCAL", "ROBOFLOW", "AUTO"]);
      if (!allowed.has(inferenceBackend)) {
        return NextResponse.json({ error: "Invalid inference backend" }, { status: 400 });
      }
    }

    const updated = await prisma.project.update({
      where: { id: project.id },
      data: {
        cameraProfileId,
        ...(activeModelId !== null ? { activeModelId } : {}),
        ...(inferenceBackend ? { inferenceBackend } : {}),
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
