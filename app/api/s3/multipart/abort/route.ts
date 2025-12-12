import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { S3Service } from "@/lib/services/s3";
import { z } from "zod";

const requestSchema = z.object({
  key: z.string().min(1, "key is required"),
  uploadId: z.string().min(1, "uploadId is required"),
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

    const { key, uploadId } = parsed.data;

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

    console.error("Failed to abort multipart upload:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(
      { error: "Failed to cancel upload. Please try again." },
      { status: 500 },
    );
  }
}
