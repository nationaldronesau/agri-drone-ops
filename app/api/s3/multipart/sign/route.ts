import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import { S3Service } from "@/lib/services/s3";
import { z } from "zod";

const requestSchema = z.object({
  key: z.string().min(1, "key is required"),
  uploadId: z.string().min(1, "uploadId is required"),
  partNumber: z.number().int().min(1, "partNumber must be >= 1"),
  contentLength: z.number().int().positive().optional(),
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

    const { key, uploadId, partNumber, contentLength } = parsed.data;
    

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
    console.error("Failed to sign multipart upload part:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json(
      { error: "Failed to sign upload part. Please try again." },
      { status: 500 },
    );
  }
}
