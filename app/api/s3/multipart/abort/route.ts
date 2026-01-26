import { NextRequest, NextResponse } from "next/server";
import { S3Service, validateS3Key } from "@/lib/services/s3";
import { z } from "zod";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { getProjectIdFromS3Key } from "@/lib/utils/s3-key";

const requestSchema = z.object({
  key: z.string().min(1, "key is required"),
  uploadId: z.string().min(1, "uploadId is required"),
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

    const { key, uploadId } = parsed.data;

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

    await S3Service.abortMultipartUpload({ key, uploadId });

    return NextResponse.json({ success: true });
  } catch (error) {
    // Handle NoSuchUpload gracefully - upload may already be completed or aborted
    const err = error as { name?: string; Code?: string; message?: string };
    if (
      err?.name === "NoSuchUpload" ||
      err?.Code === "NoSuchUpload" ||
      err?.message?.includes("NoSuchUpload")
    ) {
      console.debug("abortMultipartUpload: NoSuchUpload - already completed/aborted");
      return NextResponse.json({ success: true });
    }

    console.error("Failed to abort multipart upload:", error);
    return NextResponse.json(
      { error: "Failed to cancel upload. Please try again." },
      { status: 500 },
    );
  }
}
