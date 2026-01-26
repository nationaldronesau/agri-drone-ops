import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/db";
import { S3Service } from "@/lib/services/s3";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 }
      );
    }

    const orthomosaicId = params.id;

    // Fetch the orthomosaic from database
    const orthomosaic = await prisma.orthomosaic.findUnique({
      where: { id: orthomosaicId },
    });

    if (!orthomosaic) {
      return NextResponse.json(
        { error: "Orthomosaic not found" },
        { status: 404 }
      );
    }

    const projectAuth = await checkProjectAccess(orthomosaic.projectId);
    if (!projectAuth.hasAccess) {
      return NextResponse.json(
        { error: projectAuth.error || "Access denied" },
        { status: 403 }
      );
    }

    // Check storage type
    if (orthomosaic.storageType === "s3" && orthomosaic.s3Key) {
      // Generate signed URL for S3 orthomosaic
      try {
        const signedUrl = await S3Service.getSignedUrl(orthomosaic.s3Key);
        
        // Generate tileset URL if available
        let tilesetUrl = null;
        if (orthomosaic.s3TilesetKey) {
          // For tileset, we might want to return the prefix
          // Individual tiles will be fetched separately
          tilesetUrl = orthomosaic.s3TilesetKey;
        }
        
        return NextResponse.json({
          url: signedUrl,
          tilesetUrl: tilesetUrl,
          storageType: "s3",
          expiresIn: 3600, // 1 hour
        });
      } catch (error) {
        console.error("Failed to generate signed URL:", error);
        
        // Fallback to direct URL if available
        if (orthomosaic.originalFile) {
          return NextResponse.json({
            url: orthomosaic.originalFile,
            tilesetUrl: orthomosaic.tilesetPath,
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
      // Return local storage URLs
      return NextResponse.json({
        url: orthomosaic.originalFile,
        tilesetUrl: orthomosaic.tilesetPath,
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
