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

    const { filename, contentType, projectId, flightSession, metadata } =
      parsed.data;

    const multipart = await S3Service.createMultipartUpload({
      userId: session.user.id,
      projectId,
      fileName: filename,
      contentType,
      flightSession,
      metadata,
    });

    return NextResponse.json({
      uploadId: multipart.uploadId,
      key: multipart.key,
      bucket: multipart.bucket,
      url: multipart.url,
      partSize: multipart.partSize,
    });
  } catch (error) {
    console.error("Failed to initiate multipart upload:", error);
    return NextResponse.json(
      {
        error: "Failed to initiate multipart upload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
