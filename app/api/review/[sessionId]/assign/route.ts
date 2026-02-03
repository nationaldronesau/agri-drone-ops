import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getAuthenticatedUser } from "@/lib/auth/api-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const session = await prisma.reviewSession.findUnique({
      where: { id: params.sessionId },
      select: { id: true, teamId: true, assignedToId: true },
    });

    if (!session) {
      return NextResponse.json({ error: "Review session not found" }, { status: 404 });
    }

    const membership = await prisma.teamMember.findFirst({
      where: { teamId: session.teamId, userId: auth.userId },
      select: { role: true },
    });

    if (!membership) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const rawAssignee =
      typeof body.assigneeId === "string" && body.assigneeId.trim().length > 0
        ? body.assigneeId
        : null;
    const assigneeId = rawAssignee === "me" ? auth.userId : rawAssignee;

    const isManager = membership.role === "OWNER" || membership.role === "ADMIN";
    const isSelfAssign = assigneeId === auth.userId;
    const isSelfUnassign = assigneeId === null && session.assignedToId === auth.userId;

    if (assigneeId && !isSelfAssign && !isManager) {
      return NextResponse.json({ error: "Only admins can assign other users" }, { status: 403 });
    }

    if (assigneeId === null && !isManager && !isSelfUnassign) {
      return NextResponse.json({ error: "Only admins can unassign others" }, { status: 403 });
    }

    if (assigneeId) {
      const assigneeMembership = await prisma.teamMember.findFirst({
        where: { teamId: session.teamId, userId: assigneeId },
        select: { id: true },
      });
      if (!assigneeMembership) {
        return NextResponse.json({ error: "Assignee is not on this team" }, { status: 400 });
      }
    }

    const updated = await prisma.reviewSession.update({
      where: { id: session.id },
      data: {
        assignedToId: assigneeId,
        assignedAt: assigneeId ? new Date() : null,
      },
      include: {
        assignedTo: { select: { id: true, name: true, email: true, image: true } },
      },
    });

    return NextResponse.json({ session: updated });
  } catch (error) {
    console.error("Failed to assign review session:", error);
    return NextResponse.json({ error: "Failed to assign review session" }, { status: 500 });
  }
}
