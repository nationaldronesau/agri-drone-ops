import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { z } from "zod";

const updateSchema = z.object({
  verified: z.boolean().optional(),
  rejected: z.boolean().optional(),
  className: z.string().optional(),
  userCorrected: z.boolean().optional(),
  originalClass: z.string().nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
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
    const { id } = await params;
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
