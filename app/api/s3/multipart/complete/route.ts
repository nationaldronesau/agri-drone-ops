import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { S3Service } from "@/lib/services/s3";
import { z } from "zod";

const partSchema = z.object({
  ETag: z.string().min(1, "ETag is required"),
  PartNumber: z.number().int().min(1, "PartNumber must be >= 1"),
});

const requestSchema = z.object({
  key: z.string().min(1, "key is required"),
  uploadId: z.string().min(1, "uploadId is required"),
  parts: z.array(partSchema).min(1, "At least one part is required"),
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

    const { key, uploadId, parts } = parsed.data;

    const completed = await S3Service.completeMultipartUpload({
      key,
      uploadId,
      parts,
    });

    return NextResponse.json({
      bucket: completed.bucket,
      key: completed.key,
      location: completed.location,
      url: S3Service.buildPublicUrl(completed.key, completed.bucket),
    });
  } catch (error) {
    console.error("Failed to complete multipart upload:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(
      { error: "Failed to complete file upload. Please try again." },
      { status: 500 },
    );
  }
}
