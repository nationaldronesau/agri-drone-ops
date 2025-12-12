import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { S3Service } from "@/lib/services/s3";
import { z } from "zod";

const requestSchema = z.object({
  filename: z.string().min(1, "filename is required"),
  contentType: z
    .string()
    .min(1, "contentType is required")
    .default("application/octet-stream"),
  projectId: z.string().min(1, "projectId is required"),
  flightSession: z.string().optional(),
  metadata: z.record(z.string()).optional(),
  expiresInSeconds: z.number().int().positive().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = requestSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error: "Invalid request payload",
          details: parsed.error.flatten(),
        },
        { status: 400 },
      );
    }

    const url = await S3Service.getPresignedPutUrl({
      userId: session.user.id,
      projectId: parsed.data.projectId,
      fileName: parsed.data.filename,
      contentType: parsed.data.contentType,
      flightSession: parsed.data.flightSession,
      metadata: parsed.data.metadata,
      expiresInSeconds: parsed.data.expiresInSeconds,
    });

    return NextResponse.json(url);
  } catch (error) {
    console.error("Failed to generate presigned URL:", error);
    return NextResponse.json(
      { error: "Failed to prepare file upload. Please try again." },
      { status: 500 },
    );
  }
}
