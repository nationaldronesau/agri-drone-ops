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

    const parts = await S3Service.listParts({ key, uploadId });

    return NextResponse.json({ parts });
  } catch (error) {
    // Handle NoSuchUpload error gracefully - this happens when:
    // 1. Upload was already completed (S3 deletes the session)
    // 2. Upload was aborted
    // 3. Upload ID is invalid/expired
    // Return empty parts array to let Uppy start fresh
    const err = error as { name?: string; Code?: string; message?: string };
    if (
      err?.name === "NoSuchUpload" ||
      err?.Code === "NoSuchUpload" ||
      err?.message?.includes("NoSuchUpload")
    ) {
      console.debug("listParts: NoSuchUpload - returning empty parts array");
      return NextResponse.json({ parts: [] });
    }

    console.error("Failed to list multipart upload parts:", error);
    return NextResponse.json(
      { error: "Failed to list upload parts. Please try again." },
      { status: 500 },
    );
  }
}
