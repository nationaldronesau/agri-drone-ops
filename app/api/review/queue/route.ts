import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getAuthenticatedUser, getUserTeamIds } from "@/lib/auth/api-auth";

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const membership = await getUserTeamIds();
    if (membership.dbError) {
      return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    if (membership.teamIds.length === 0) {
      return NextResponse.json({ sessions: [] });
    }

    const { searchParams } = new URL(request.url);
    const assigned = searchParams.get("assigned") || "all";

    const where: Record<string, unknown> = {
      teamId: { in: membership.teamIds },
      status: { not: "archived" },
    };

    if (assigned === "me") {
      where.assignedToId = auth.userId;
    } else if (assigned === "unassigned") {
      where.assignedToId = null;
    }

    const sessions = await prisma.reviewSession.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        assignedTo: { select: { id: true, name: true, email: true, image: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("Failed to load review queue:", error);
    return NextResponse.json({ error: "Failed to load review queue" }, { status: 500 });
  }
}
