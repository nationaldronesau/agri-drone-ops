import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const detection = await prisma.detection.findUnique({
      where: { id: params.id },
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
