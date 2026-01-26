import { NextRequest, NextResponse } from "next/server";
import { S3Service, validateS3Key } from "@/lib/services/s3";
import { z } from "zod";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { getProjectIdFromS3Key } from "@/lib/utils/s3-key";

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
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 },
      );
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

    // SECURITY: Validate S3 key to prevent path traversal attacks
    if (!validateS3Key(key)) {
      return NextResponse.json(
        { error: "Invalid S3 key format" },
        { status: 400 },
      );
    }

    const projectId = getProjectIdFromS3Key(key);
    if (!projectId) {
      return NextResponse.json(
        { error: "Invalid S3 key format" },
        { status: 400 },
      );
    }

    const projectAuth = await checkProjectAccess(projectId);
    if (!projectAuth.hasAccess) {
      return NextResponse.json(
        { error: projectAuth.error || "Access denied" },
        { status: 403 },
      );
    }

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
    console.error("Failed to complete multipart upload:", error);
    return NextResponse.json(
      { error: "Failed to complete file upload. Please try again." },
      { status: 500 },
    );
  }
}
