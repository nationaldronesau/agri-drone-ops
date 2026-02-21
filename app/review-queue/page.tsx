"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ClipboardList, UserPlus, UserMinus } from "lucide-react";

type QueueFilter = "me" | "unassigned" | "all";

interface ReviewSession {
  id: string;
  projectId: string;
  workflowType: string;
  assetCount: number;
  itemsReviewed: number;
  itemsAccepted: number;
  itemsRejected: number;
  createdAt: string;
  status: string;
  project: { id: string; name: string };
  assignedTo?: { id: string; name?: string | null; email?: string | null } | null;
}

export default function ReviewQueuePage() {
  const [sessions, setSessions] = useState<ReviewSession[]>([]);
  const [filter, setFilter] = useState<QueueFilter>("me");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadSessions = async (nextFilter: QueueFilter) => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`/api/review/queue?assigned=${nextFilter}`, {
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.error || "Failed to load review queue");
      }
      setSessions(data.sessions || []);
    } catch (err) {
      const message =
        err instanceof Error && err.name === "AbortError"
          ? "Review queue request timed out. Try again."
          : err instanceof Error
            ? err.message
            : "Failed to load review queue";
      setError(message);
    } finally {
      clearTimeout(timeoutId);
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSessions(filter);
  }, [filter]);

  const assignToMe = async (sessionId: string) => {
    setActionLoading(sessionId);
    try {
      const res = await fetch(`/api/review/${sessionId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId: "me" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to assign session");
      }
      await loadSessions(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign session");
    } finally {
      setActionLoading(null);
    }
  };

  const unassignSelf = async (sessionId: string) => {
    setActionLoading(sessionId);
    try {
      const res = await fetch(`/api/review/${sessionId}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assigneeId: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to unassign session");
      }
      await loadSessions(filter);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unassign session");
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="p-6 lg:p-8 space-y-6">
        <div className="flex items-center gap-3">
          <ClipboardList className="w-6 h-6 text-blue-600" />
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Review Queue</h1>
            <p className="text-gray-600">Track and assign review sessions.</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {(["me", "unassigned", "all"] as QueueFilter[]).map((value) => (
            <Button
              key={value}
              variant={filter === value ? "default" : "outline"}
              onClick={() => setFilter(value)}
            >
              {value === "me"
                ? "My Assignments"
                : value === "unassigned"
                  ? "Unassigned"
                  : "All Sessions"}
            </Button>
          ))}
        </div>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-700">
            {error}
          </div>
        )}

        {loading ? (
          <p className="text-gray-500">Loading sessions...</p>
        ) : sessions.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-gray-500">
              No sessions in this view.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4">
            {sessions.map((session) => (
              <Card key={session.id}>
                <CardHeader>
                  <CardTitle className="text-lg">{session.project.name}</CardTitle>
                  <CardDescription>
                    {session.workflowType} • {session.assetCount} assets •{" "}
                    {session.itemsReviewed}/{session.assetCount} reviewed
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-gray-600">
                    Assigned to:{" "}
                    <span className="font-medium">
                      {session.assignedTo?.name || session.assignedTo?.email || "Unassigned"}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {!session.assignedTo && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => assignToMe(session.id)}
                        disabled={actionLoading === session.id}
                      >
                        <UserPlus className="w-4 h-4 mr-2" />
                        Assign to me
                      </Button>
                    )}
                    {session.assignedTo && filter === "me" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => unassignSelf(session.id)}
                        disabled={actionLoading === session.id}
                      >
                        <UserMinus className="w-4 h-4 mr-2" />
                        Unassign
                      </Button>
                    )}
                    <Link href={`/review?sessionId=${session.id}`}>
                      <Button size="sm">Open Review</Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
