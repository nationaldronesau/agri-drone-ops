import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { getAuthenticatedUser, getUserTeamIds } from "@/lib/auth/api-auth";
import { getReviewItemSummaries } from "@/lib/services/review-summary";

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
    const requestedLimit = Number.parseInt(searchParams.get("limit") || "100", 10);
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 100;

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
      take: limit,
    });

    const summaries = await getReviewItemSummaries(prisma, sessions);
    const sessionsWithCounts = sessions.map((session) => ({
      ...session,
      summary: summaries.get(session.id) || {
        pendingCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        exportReadyCount: 0,
        totalItemCount: 0,
      },
      pendingCount: summaries.get(session.id)?.pendingCount ?? 0,
      acceptedCount: summaries.get(session.id)?.acceptedCount ?? 0,
      rejectedCount: summaries.get(session.id)?.rejectedCount ?? 0,
      exportReadyCount: summaries.get(session.id)?.exportReadyCount ?? 0,
      totalItemCount: summaries.get(session.id)?.totalItemCount ?? 0,
    }));

    return NextResponse.json({ sessions: sessionsWithCounts });
  } catch (error) {
    console.error("Failed to load review queue:", error);
    return NextResponse.json({ error: "Failed to load review queue" }, { status: 500 });
  }
}
