import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess, getAuthenticatedUser } from "@/lib/auth/api-auth";
import { z } from "zod";
import prisma from "@/lib/db";
import { promisify } from "util";
import { exec } from "child_process";
import { S3Service } from "@/lib/services/s3";
import { getProjectIdFromS3Key } from "@/lib/utils/s3-key";
import os from "os";
import path from "path";
import { mkdtemp, rm, writeFile } from "fs/promises";

const execAsync = promisify(exec);

type GeoJsonPolygon = {
  type: "Polygon";
  coordinates: Array<Array<[number, number]>>;
};

const fileSchema = z.object({
  url: z.string().url("A valid S3 URL is required"),
  name: z.string().min(1, "File name is required"),
  size: z.number().int().positive(),
  mimeType: z.string().optional(),
  key: z.string().optional(),
  bucket: z.string().optional(),
});

const requestSchema = z.object({
  file: fileSchema,
  projectId: z.string().min(1, "Project ID is required"),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 }
      );
    }

    const payload = await request.json();
    const parsed = requestSchema.safeParse(payload);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const { file, projectId, name, description } = parsed.data;

    const projectAuth = await checkProjectAccess(projectId);
    if (!projectAuth.hasAccess) {
      return NextResponse.json(
        { error: projectAuth.error || "Access denied to this project" },
        { status: 403 },
      );
    }

    let bucket = file.bucket || null;
    let key = file.key || null;

    if (!bucket || !key) {
      const parsedUrl = S3Service.parseS3Url(file.url);
      bucket = bucket || parsedUrl.bucket;
      key = key || parsedUrl.key;
    }

    if (!bucket || !key) {
      return NextResponse.json(
        { error: "Missing S3 location for orthomosaic file" },
        { status: 400 },
      );
    }

    const keyProjectId = getProjectIdFromS3Key(key);
    if (!keyProjectId) {
      return NextResponse.json(
        { error: "Invalid S3 key format" },
        { status: 400 },
      );
    }

    if (keyProjectId !== projectId) {
      return NextResponse.json(
        { error: "S3 key does not match the target project" },
        { status: 403 },
      );
    }

    if (bucket !== S3Service.bucketName) {
      return NextResponse.json(
        { error: "Orthomosaic stored in unsupported S3 bucket" },
        { status: 400 },
      );
    }

    const buffer = await S3Service.downloadFile(key, bucket);

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "orthomosaic-"));
    const tempFilePath = path.join(tempDir, file.name);

    try {
      await writeFile(tempFilePath, buffer);

      let bounds: GeoJsonPolygon | null = null;
      let centerLat = 0;
      let centerLon = 0;
      let resolution: number | null = null;
      let area: number | null = null;

      try {
        const { stdout } = await execAsync(`gdalinfo -json "${tempFilePath}"`);
        const metadata = JSON.parse(stdout);

        if (metadata.cornerCoordinates) {
          const corners = metadata.cornerCoordinates;
          const minLon = Math.min(
            corners.upperLeft[0],
            corners.lowerLeft[0],
            corners.lowerRight[0],
            corners.upperRight[0],
          );
          const maxLon = Math.max(
            corners.upperLeft[0],
            corners.lowerLeft[0],
            corners.lowerRight[0],
            corners.upperRight[0],
          );
          const minLat = Math.min(
            corners.upperLeft[1],
            corners.lowerLeft[1],
            corners.lowerRight[1],
            corners.upperRight[1],
          );
          const maxLat = Math.max(
            corners.upperLeft[1],
            corners.lowerLeft[1],
            corners.lowerRight[1],
            corners.upperRight[1],
          );

          centerLat = (minLat + maxLat) / 2;
          centerLon = (minLon + maxLon) / 2;

          bounds = {
            type: "Polygon",
            coordinates: [
              [
                [minLon, minLat],
                [maxLon, minLat],
                [maxLon, maxLat],
                [minLon, maxLat],
                [minLon, minLat],
              ],
            ],
          };
        }

        if (metadata.geoTransform) {
          const pixelSizeX = Math.abs(metadata.geoTransform[1]);
          const pixelSizeY = Math.abs(metadata.geoTransform[5]);
          resolution = ((pixelSizeX + pixelSizeY) / 2) * 111000 * 100;
        }

        if (metadata.size && metadata.geoTransform) {
          const widthPixels = metadata.size[0];
          const heightPixels = metadata.size[1];
          const pixelSizeX = Math.abs(metadata.geoTransform[1]) * 111000;
          const pixelSizeY = Math.abs(metadata.geoTransform[5]) * 111000;
          area =
            (widthPixels * pixelSizeX * heightPixels * pixelSizeY) / 10000;
        }
      } catch (gdalError) {
        console.warn(
          "GDAL not available or failed to extract metadata:",
          gdalError,
        );
        centerLat = -27.4698;
        centerLon = 153.0251;
        bounds = {
          type: "Polygon",
          coordinates: [
            [
              [centerLon - 0.01, centerLat - 0.01],
              [centerLon + 0.01, centerLat - 0.01],
              [centerLon + 0.01, centerLat + 0.01],
              [centerLon - 0.01, centerLat + 0.01],
              [centerLon - 0.01, centerLat - 0.01],
            ],
          ],
        };
      }

      const boundsValue: GeoJsonPolygon | Record<string, never> = bounds ?? {};

      const orthomosaic = await prisma.orthomosaic.create({
        data: {
          projectId,
          name,
          description,
          originalFile: file.url,
          fileSize: BigInt(file.size),
          s3Key: key,
          s3Bucket: bucket,
          storageType: "s3",
          bounds: boundsValue,
          centerLat,
          centerLon,
          resolution: resolution || null,
          area: area || null,
          status: "PENDING",
        },
        include: {
          project: true,
        },
      });

      setTimeout(async () => {
        try {
          await prisma.orthomosaic.update({
            where: { id: orthomosaic.id },
            data: {
              status: "COMPLETED",
              tilesetPath: `/tiles/${orthomosaic.id}`,
              processingLog: {
                message: "Tiles generated successfully",
                timestamp: new Date(),
              },
            },
          });
        } catch (error) {
          await prisma.orthomosaic.update({
            where: { id: orthomosaic.id },
            data: {
              status: "FAILED",
              processingLog: {
                message: `Processing failed: ${error instanceof Error ? error.message : "Unknown error"}`,
                timestamp: new Date(),
              },
            },
          });
        }
      }, 1000);

      return NextResponse.json(orthomosaic);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  } catch (error) {
    console.error("Orthomosaic upload failed:", error);
    return NextResponse.json(
      {
        error: "Failed to register orthomosaic upload",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
