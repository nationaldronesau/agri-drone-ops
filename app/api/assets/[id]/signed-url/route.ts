import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { S3Service } from "@/lib/services/s3";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const assetId = params.id;

    // Fetch the asset from database
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
    });

    if (!asset) {
      return NextResponse.json(
        { error: "Asset not found" },
        { status: 404 }
      );
    }

    // Check storage type
    if (asset.storageType === "s3" && asset.s3Key) {
      // Generate signed URL for S3 asset
      try {
        const signedUrl = await S3Service.getSignedUrl(asset.s3Key);
        
        return NextResponse.json({
          url: signedUrl,
          storageType: "s3",
          expiresIn: 3600, // 1 hour
        });
      } catch (error) {
        console.error("Failed to generate signed URL:", error);
        
        // Fallback to direct URL if available
        if (asset.storageUrl) {
          return NextResponse.json({
            url: asset.storageUrl,
            storageType: "s3",
            fallback: true,
          });
        }
        
        return NextResponse.json(
          { error: "Failed to generate signed URL" },
          { status: 500 }
        );
      }
    } else {
      // Return local storage URL
      return NextResponse.json({
        url: asset.storageUrl,
        storageType: "local",
      });
    }
  } catch (error) {
    console.error("Error generating signed URL:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}