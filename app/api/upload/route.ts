import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth/config";
import exifr from "exifr";
import { z } from "zod";
import prisma from "@/lib/db";
import {
  ModelType,
  ROBOFLOW_MODELS,
  roboflowService,
} from "@/lib/services/roboflow";
import { pixelToGeo } from "@/lib/utils/georeferencing";
import { S3Service } from "@/lib/services/s3";

const fileSchema = z.object({
  url: z.string().url("A valid S3 URL is required"),
  name: z.string().min(1, "File name is required"),
  size: z.number().int().nonnegative(),
  mimeType: z.string().optional(),
  key: z.string().optional(),
  bucket: z.string().optional(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1, "At least one file is required"),
  projectId: z.string().min(1, "Project ID is required"),
  runDetection: z.boolean().optional().default(false),
  detectionModels: z.string().optional(),
  flightSession: z.string().optional(),
});

interface ExtractedMetadata {
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalPitch: number | null;
  gimbalRoll: number | null;
  gimbalYaw: number | null;
  lrfDistance: number | null;
  lrfTargetLat: number | null;
  lrfTargetLon: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

const defaultExtractedMetadata = (): ExtractedMetadata => ({
  gpsLatitude: null,
  gpsLongitude: null,
  altitude: null,
  gimbalPitch: null,
  gimbalRoll: null,
  gimbalYaw: null,
  lrfDistance: null,
  lrfTargetLat: null,
  lrfTargetLon: null,
  imageWidth: null,
  imageHeight: null,
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
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const {
      files,
      projectId,
      runDetection,
      detectionModels,
      flightSession,
    } = parsed.data;

    const requestedModels: ModelType[] =
      detectionModels && detectionModels.length > 0
        ? detectionModels
            .split(",")
            .map((model) => model.trim())
            .filter((model): model is ModelType => model in ROBOFLOW_MODELS)
        : (Object.keys(ROBOFLOW_MODELS) as ModelType[]);

    const modelsToRun: ModelType[] =
      requestedModels.length > 0
        ? requestedModels
        : (Object.keys(ROBOFLOW_MODELS) as ModelType[]);

    const uploadResults: any[] = [];

    const cloudFrontBase =
      process.env.CLOUDFRONT_BASE_URL ??
      process.env.NEXT_PUBLIC_CLOUDFRONT_BASE_URL ??
      null;

    for (const file of files) {
      try {
        let bucket = file.bucket || null;
        let key = file.key || null;

        if (!bucket || !key) {
          const parsedUrl = S3Service.parseS3Url(file.url);
          bucket = bucket || parsedUrl.bucket;
          key = key || parsedUrl.key;
        }

        if (!bucket || !key) {
          throw new Error("Missing S3 object location for file.");
        }

        if (bucket !== S3Service.bucketName) {
          throw new Error("File is stored in an unsupported S3 bucket.");
        }

        if (!S3Service.isKeyWithinUserScope(key, session.user.id)) {
          throw new Error("Provided S3 key is outside of the allowed prefix.");
        }

        const buffer = await S3Service.downloadFile(key, bucket);
        const extractedData = defaultExtractedMetadata();
        let fullMetadata: Record<string, unknown> | null = null;

        try {
          const gpsData = await exifr.gps(buffer);
          if (gpsData) {
            extractedData.gpsLatitude = gpsData.latitude ?? null;
            extractedData.gpsLongitude = gpsData.longitude ?? null;
            extractedData.altitude = gpsData.altitude ?? null;
          }

          const exifData = await exifr.parse(buffer, {
            exif: true,
            pick: [
              "FocalLength",
              "DateTimeOriginal",
              "ISO",
              "ExposureTime",
              "FNumber",
              "ExifImageWidth",
              "ExifImageHeight",
            ],
          });

          if (exifData) {
            extractedData.imageWidth = exifData.ExifImageWidth ?? null;
            extractedData.imageHeight = exifData.ExifImageHeight ?? null;
          }

          const xmpData = await exifr.parse(buffer, {
            xmp: true,
            mergeOutput: false,
          });

          if (xmpData && xmpData.xmp) {
            const droneFields = xmpData.xmp;
            for (const [keyName, value] of Object.entries(droneFields)) {
              const keyLower = keyName.toLowerCase();

              if (
                keyLower.includes("lat") &&
                typeof value === "number" &&
                extractedData.gpsLatitude === null
              ) {
                extractedData.gpsLatitude = value;
              }
              if (
                keyLower.includes("lon") &&
                typeof value === "number" &&
                extractedData.gpsLongitude === null
              ) {
                extractedData.gpsLongitude = value;
              }
              if (
                keyLower.includes("gimbal") &&
                keyLower.includes("pitch") &&
                typeof value === "number"
              ) {
                extractedData.gimbalPitch = value;
              }
              if (
                keyLower.includes("altitude") &&
                typeof value === "number" &&
                extractedData.altitude === null
              ) {
                extractedData.altitude = value;
              }
              if (keyLower.includes("lrf") && typeof value === "number") {
                if (keyLower.includes("distance")) {
                  extractedData.lrfDistance = value;
                }
                if (keyLower.includes("lat")) {
                  extractedData.lrfTargetLat = value;
                }
                if (keyLower.includes("lon")) {
                  extractedData.lrfTargetLon = value;
                }
              }
            }
          }

          fullMetadata = await exifr.parse(buffer, {
            gps: true,
            xmp: true,
            exif: true,
            mergeOutput: true,
          });

          if (fullMetadata) {
            extractedData.altitude =
              extractedData.altitude ??
              (fullMetadata["AbsoluteAltitude"] as number | undefined) ??
              (fullMetadata["RelativeAltitude"] as number | undefined) ??
              (fullMetadata["drone-dji:AbsoluteAltitude"] as
                | number
                | undefined) ??
              (fullMetadata["drone-dji:RelativeAltitude"] as
                | number
                | undefined) ??
              null;

            extractedData.gimbalPitch =
              (fullMetadata["GimbalPitchDegree"] as number | undefined) ??
              (fullMetadata["drone-dji:GimbalPitchDegree"] as
                | number
                | undefined) ??
              extractedData.gimbalPitch;
            extractedData.gimbalRoll =
              (fullMetadata["GimbalRollDegree"] as number | undefined) ??
              (fullMetadata["drone-dji:GimbalRollDegree"] as number | undefined) ??
              extractedData.gimbalRoll;
            extractedData.gimbalYaw =
              (fullMetadata["GimbalYawDegree"] as number | undefined) ??
              (fullMetadata["drone-dji:GimbalYawDegree"] as number | undefined) ??
              extractedData.gimbalYaw;

            extractedData.lrfDistance =
              (fullMetadata["LRFTargetDistance"] as number | undefined) ??
              (fullMetadata["drone-dji:LRFTargetDistance"] as
                | number
                | undefined) ??
              extractedData.lrfDistance;
            extractedData.lrfTargetLat =
              (fullMetadata["LRFTargetLat"] as number | undefined) ??
              (fullMetadata["drone-dji:LRFTargetLat"] as number | undefined) ??
              extractedData.lrfTargetLat;
            extractedData.lrfTargetLon =
              (fullMetadata["LRFTargetLon"] as number | undefined) ??
              (fullMetadata["drone-dji:LRFTargetLon"] as number | undefined) ??
              extractedData.lrfTargetLon;
          }
        } catch (metadataError) {
          console.error("Error parsing EXIF/XMP:", metadataError);
        }

        const cloudFrontUrl =
          key && cloudFrontBase
            ? `${cloudFrontBase.replace(/\/$/, "")}/${key}`
            : file.url;

        const asset = await prisma.asset.create({
          data: {
            fileName: file.name,
            storageUrl: cloudFrontUrl,
            mimeType: file.mimeType || "application/octet-stream",
            fileSize: file.size,
            s3Key: key,
            s3Bucket: bucket,
            storageType: "s3",
            gpsLatitude: extractedData.gpsLatitude,
            gpsLongitude: extractedData.gpsLongitude,
            altitude: extractedData.altitude,
            gimbalPitch: extractedData.gimbalPitch,
            gimbalRoll: extractedData.gimbalRoll,
            gimbalYaw: extractedData.gimbalYaw,
            lrfDistance: extractedData.lrfDistance,
            lrfTargetLat: extractedData.lrfTargetLat,
            lrfTargetLon: extractedData.lrfTargetLon,
            imageWidth: extractedData.imageWidth,
            imageHeight: extractedData.imageHeight,
            metadata: fullMetadata,
            projectId,
            createdById: session.user.id,
            flightSession: flightSession || null,
          },
        });

        const detections: any[] = [];

        if (runDetection && extractedData.gpsLatitude && extractedData.gpsLongitude) {
          try {
            const imageBase64 = buffer.toString("base64");
            const detectionResults = await roboflowService.detectMultipleModels(
              imageBase64,
              modelsToRun,
            );

            if (
              detectionResults.length > 0 &&
              extractedData.imageWidth &&
              extractedData.imageHeight
            ) {
              const job = await prisma.processingJob.create({
                data: {
                  projectId,
                  type: "AI_DETECTION",
                  status: "COMPLETED",
                  config: { models: modelsToRun },
                  completedAt: new Date(),
                },
              });

              for (const detection of detectionResults) {
                const geoCoords = pixelToGeo(
                  detection.x,
                  detection.y,
                  extractedData.imageWidth,
                  extractedData.imageHeight,
                  extractedData.gpsLatitude,
                  extractedData.gpsLongitude,
                  extractedData.altitude || 100,
                  extractedData.gimbalPitch || 0,
                  extractedData.gimbalRoll || 0,
                  extractedData.gimbalYaw || 0,
                );

                const savedDetection = await prisma.detection.create({
                  data: {
                    jobId: job.id,
                    assetId: asset.id,
                    type: "AI",
                    className: detection.class,
                    confidence: detection.confidence,
                    boundingBox: {
                      x: detection.x,
                      y: detection.y,
                      width: detection.width,
                      height: detection.height,
                    },
                    geoCoordinates: {
                      type: "Point",
                      coordinates: [geoCoords.longitude, geoCoords.latitude],
                    },
                    centerLat: geoCoords.latitude,
                    centerLon: geoCoords.longitude,
                    metadata: {
                      modelType: detection.modelType,
                      color: detection.color,
                    },
                  },
                });

                detections.push({
                  ...detection,
                  geoCoordinates: geoCoords,
                  id: savedDetection.id,
                });
              }
            }
          } catch (detectionError) {
            console.error("Detection failed:", detectionError);
          }
        }

        uploadResults.push({
          id: asset.id,
          name: file.name,
          url: cloudFrontUrl,
          bucket,
          s3Key: key,
          size: file.size,
          metadata: fullMetadata,
          gpsLatitude: extractedData.gpsLatitude,
          gpsLongitude: extractedData.gpsLongitude,
          altitude: extractedData.altitude,
          detections,
          success: true,
          warning:
            !extractedData.gpsLatitude || !extractedData.gpsLongitude
              ? "No GPS data found in image"
              : null,
        });
      } catch (fileError) {
        console.error(`Error processing file ${file.name}:`, fileError);
        uploadResults.push({
          name: file.name,
          url: file.url,
          size: file.size,
          success: false,
          error:
            fileError instanceof Error
              ? fileError.message
              : "Unknown processing error",
        });
      }
    }

    return NextResponse.json({
      message: `Processed ${uploadResults.filter((file) => file.success).length} of ${files.length} files`,
      files: uploadResults,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      {
        error: "Failed to process uploads",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    );
  }
}
