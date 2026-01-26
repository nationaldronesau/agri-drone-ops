import { NextRequest, NextResponse } from "next/server";
import { S3Service, validateS3Key } from "@/lib/services/s3";
import { z } from "zod";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { getProjectIdFromS3Key } from "@/lib/utils/s3-key";

const requestSchema = z.object({
  key: z.string().min(1, "key is required"),
  uploadId: z.string().min(1, "uploadId is required"),
  partNumber: z.number().int().min(1, "partNumber must be >= 1"),
  contentLength: z.number().int().positive().optional(),
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

    const { key, uploadId, partNumber, contentLength } = parsed.data;

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

    const presign = await S3Service.signMultipartUploadPart({
      key,
      uploadId,
      partNumber,
      contentLength,
    });

    return NextResponse.json({
      url: presign.url,
      expiresIn: presign.expiresIn,
    });
  } catch (error) {
    console.error("Failed to sign multipart upload part:", error);
    return NextResponse.json(
      { error: "Failed to sign upload part. Please try again." },
      { status: 500 },
    );
  }
}
