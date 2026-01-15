import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/api-auth";
import { normalizeDetectionType } from "@/lib/utils/detection-types";
import exifr from "exifr";
import { z } from "zod";
import prisma from "@/lib/db";
import { Prisma } from "@prisma/client";
import {
  ModelType,
  ROBOFLOW_MODELS,
  roboflowService,
} from "@/lib/services/roboflow";
import { formatModelId } from "@/lib/services/yolo";
import { processInferenceJob } from "@/lib/services/inference";
import { checkRedisConnection } from "@/lib/queue/redis";
import { enqueueInferenceJob } from "@/lib/queue/inference-queue";
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

const dynamicModelSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  version: z.number(),
  endpoint: z.string(),
  classes: z.array(z.string()),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1, "At least one file is required"),
  projectId: z.string().min(1, "Project ID is required"),
  runDetection: z.boolean().optional().default(false),
  detectionModels: z.string().optional(), // Legacy: comma-separated model keys
  dynamicModels: z.array(dynamicModelSchema).optional(), // New: dynamic models from workspace
  flightSession: z.string().optional(),
});

const AUTO_INFERENCE_CONFIDENCE = 0.25;
const MAX_SYNC_INFERENCE_IMAGES = 50;

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

/**
 * SAFETY CRITICAL: Validates GPS coordinates for spray drone operations
 * Invalid coordinates could send drones to wrong locations
 */
function isValidGPSCoordinate(lat: number | null, lon: number | null): boolean {
  if (lat === null || lon === null) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  return true;
}

/**
 * SAFETY CRITICAL: Validates altitude values
 * Ensures altitude is within reasonable range for drone operations
 */
function isValidAltitude(alt: number | null): boolean {
  if (alt === null) return true; // altitude is optional
  if (!Number.isFinite(alt)) return false;
  if (alt < -500 || alt > 50000) return false; // reasonable range for drones in meters
  return true;
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
      dynamicModels,
      flightSession,
    } = parsed.data;

    // Verify user is authenticated AND has access to the project
    const projectAuth = await checkProjectAccess(projectId);
    if (!projectAuth.authenticated) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!projectAuth.hasAccess) {
      return NextResponse.json(
        { error: projectAuth.error || "Access denied to this project" },
        { status: 403 }
      );
    }

    const userId = projectAuth.userId!;
    const projectSettings = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        teamId: true,
        activeModelId: true,
        autoInferenceEnabled: true,
      },
    });

    if (!projectSettings) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Check if we're using dynamic models (new) or legacy hardcoded models
    const useDynamicModels = dynamicModels && dynamicModels.length > 0;

    // Legacy model handling (for backwards compatibility)
    const requestedModels: ModelType[] =
      !useDynamicModels && detectionModels && detectionModels.length > 0
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
    const autoInferenceAssetIds: string[] = [];
    let autoInferenceSkipped = 0;
    let autoInferenceSummary:
      | {
          started: boolean;
          status?: string;
          jobId?: string;
          totalImages?: number;
          processedImages?: number;
          detectionsFound?: number;
          skippedImages?: number;
          error?: string;
        }
      | undefined;

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

        // Check for duplicate files by S3 key
        const existingAsset = await prisma.asset.findFirst({
          where: {
            OR: [
              { s3Key: key },
              // Also check by filename + project to catch re-uploads
              { fileName: file.name, projectId }
            ]
          }
        });

        if (existingAsset) {
          console.log(`Skipping duplicate file: ${file.name} (existing asset: ${existingAsset.id})`);
          uploadResults.push({
            id: existingAsset.id,
            name: file.name,
            url: existingAsset.storageUrl,
            size: file.size,
            success: true,
            warning: "File already exists in project, skipped duplicate upload",
            duplicate: true,
          });
          continue;
        }

        const buffer = await S3Service.downloadFile(key, bucket);
        const extractedData = defaultExtractedMetadata();
        let fullMetadata: Record<string, unknown> | null = null;

        // Track EXIF extraction warnings for this file
        const fileWarnings: string[] = [];

        try {
          const gpsData = await exifr.gps(buffer);
          if (gpsData) {
            extractedData.gpsLatitude = gpsData.latitude ?? null;
            extractedData.gpsLongitude = gpsData.longitude ?? null;
            extractedData.altitude = gpsData.altitude ?? null;
          } else {
            fileWarnings.push("No GPS data found in EXIF metadata");
          }

          // SAFETY CRITICAL: Validate GPS coordinates immediately after extraction
          if (!isValidGPSCoordinate(extractedData.gpsLatitude, extractedData.gpsLongitude)) {
            console.warn(`[SAFETY] Invalid GPS coordinates for ${file.name}: lat=${extractedData.gpsLatitude}, lon=${extractedData.gpsLongitude}`);
            extractedData.gpsLatitude = null;
            extractedData.gpsLongitude = null;
          }

          if (!isValidAltitude(extractedData.altitude)) {
            console.warn(`[SAFETY] Invalid altitude for ${file.name}: ${extractedData.altitude}`);
            extractedData.altitude = null;
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

          // SAFETY CRITICAL: Re-validate GPS coordinates after XMP extraction
          // XMP data might override initial GPS values
          if (!isValidGPSCoordinate(extractedData.gpsLatitude, extractedData.gpsLongitude)) {
            console.warn(`[SAFETY] Invalid GPS coordinates after XMP parsing for ${file.name}: lat=${extractedData.gpsLatitude}, lon=${extractedData.gpsLongitude}`);
            extractedData.gpsLatitude = null;
            extractedData.gpsLongitude = null;
          }

          if (!isValidAltitude(extractedData.altitude)) {
            console.warn(`[SAFETY] Invalid altitude after XMP parsing for ${file.name}: ${extractedData.altitude}`);
            extractedData.altitude = null;
          }

          // SAFETY CRITICAL: Validate LRF target coordinates if present
          if (extractedData.lrfTargetLat !== null && extractedData.lrfTargetLon !== null) {
            if (!isValidGPSCoordinate(extractedData.lrfTargetLat, extractedData.lrfTargetLon)) {
              console.warn(`[SAFETY] Invalid LRF target coordinates for ${file.name}: lat=${extractedData.lrfTargetLat}, lon=${extractedData.lrfTargetLon}`);
              extractedData.lrfTargetLat = null;
              extractedData.lrfTargetLon = null;
            }
          }
        } catch (metadataError) {
          console.error("Error parsing EXIF/XMP:", metadataError);
          fileWarnings.push(
            `EXIF metadata extraction failed: ${metadataError instanceof Error ? metadataError.message : 'Unknown error'}`
          );
        }

        const cloudFrontUrl =
          key && cloudFrontBase
            ? `${cloudFrontBase.replace(/\/$/, "")}/${key}`
            : file.url;

        // Run AI detection before transaction (external API call)
        let detectionResults: any[] = [];
        if (runDetection && extractedData.gpsLatitude && extractedData.gpsLongitude) {
          try {
            const imageBase64 = buffer.toString("base64");
            const result = useDynamicModels
              ? await roboflowService.detectWithDynamicModels(imageBase64, dynamicModels!)
              : await roboflowService.detectMultipleModels(imageBase64, modelsToRun);

            detectionResults = result.detections;

            // Report any model failures as warnings (not silent!)
            if (result.failures.length > 0) {
              const failedModels = result.failures.map(f => f.model).join(', ');
              fileWarnings.push(`Some AI models failed: ${failedModels}. Partial detection results available.`);
            }
          } catch (detectionError) {
            console.error("Detection API call failed:", detectionError);
            fileWarnings.push("AI detection failed - image uploaded without detections");
          }
        }

        // Use transaction for all database operations to ensure data consistency
        // If any step fails, all changes are rolled back
        const { asset, detections } = await prisma.$transaction(async (tx) => {
          // Create asset
          const asset = await tx.asset.create({
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
              createdById: userId,
              flightSession: flightSession || null,
            },
          });

          const detections: any[] = [];

          // Create processing job and detections if we have valid detection results
          if (
            detectionResults.length > 0 &&
            extractedData.imageWidth &&
            extractedData.imageHeight &&
            extractedData.gpsLatitude &&
            extractedData.gpsLongitude
          ) {
            const job = await tx.processingJob.create({
              data: {
                projectId,
                type: "AI_DETECTION",
                status: "COMPLETED",
                config: useDynamicModels
                  ? { dynamicModels: dynamicModels!.map((m) => m.projectName) }
                  : { models: modelsToRun },
                completedAt: new Date(),
              },
            });

            // Prepare all valid detections for batch creation
            const validDetections: any[] = [];

            // Build georeferencing params once for this image
            const geoParams = {
              gpsLatitude: extractedData.gpsLatitude!,
              gpsLongitude: extractedData.gpsLongitude!,
              altitude: extractedData.altitude || 100,
              gimbalRoll: extractedData.gimbalRoll || 0,
              gimbalPitch: extractedData.gimbalPitch || 0,
              gimbalYaw: extractedData.gimbalYaw || 0,
              cameraFov: 84, // Default FOV for DJI drones
              imageWidth: extractedData.imageWidth!,
              imageHeight: extractedData.imageHeight!,
              lrfDistance: extractedData.lrfDistance ?? undefined,
              lrfTargetLat: extractedData.lrfTargetLat ?? undefined,
              lrfTargetLon: extractedData.lrfTargetLon ?? undefined,
            };

            for (const detection of detectionResults) {
              try {
                const pixel = { x: detection.x, y: detection.y };
                const geoResult = pixelToGeo(geoParams, pixel);

                // Handle potential Promise return (when DTM is used)
                const geoCoords = geoResult instanceof Promise ? await geoResult : geoResult;

                // SAFETY CRITICAL: Validate detection coordinates before saving
                // pixelToGeo returns { lat, lon } not { latitude, longitude }
                if (!isValidGPSCoordinate(geoCoords.lat, geoCoords.lon)) {
                  console.warn(`[SAFETY] Skipping detection with invalid coordinates for ${file.name}: lat=${geoCoords.lat}, lon=${geoCoords.lon}, class=${detection.class}`);
                  continue;
                }

                validDetections.push({ detection, geoCoords });
              } catch (geoError) {
                // SAFETY: Skip this detection if georeferencing fails, don't abort entire upload
                console.warn(`[SAFETY] Georeferencing failed for detection in ${file.name}, class=${detection.class}:`, geoError);
                continue;
              }
            }

            // Create all detections within the transaction
            for (const { detection, geoCoords } of validDetections) {
              const savedDetection = await tx.detection.create({
                data: {
                  jobId: job.id,
                  assetId: asset.id,
                  type: "AI",
                  className: normalizeDetectionType(detection.class),
                  confidence: detection.confidence,
                  boundingBox: {
                    x: detection.x,
                    y: detection.y,
                    width: detection.width,
                    height: detection.height,
                  },
                  geoCoordinates: {
                    type: "Point",
                    coordinates: [geoCoords.lon, geoCoords.lat],
                  },
                  centerLat: geoCoords.lat,
                  centerLon: geoCoords.lon,
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

          return { asset, detections };
        });

        if (projectSettings.autoInferenceEnabled && projectSettings.activeModelId) {
          if (
            extractedData.gpsLatitude != null &&
            extractedData.gpsLongitude != null &&
            extractedData.imageWidth != null &&
            extractedData.imageHeight != null
          ) {
            autoInferenceAssetIds.push(asset.id);
          } else {
            autoInferenceSkipped += 1;
          }
        }

        // Add GPS warning to the list if coordinates are missing
        if (!extractedData.gpsLatitude || !extractedData.gpsLongitude) {
          if (!fileWarnings.some(w => w.includes("GPS"))) {
            fileWarnings.push("Image is missing GPS coordinates - detection positions may be inaccurate");
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
          warnings: fileWarnings.length > 0 ? fileWarnings : undefined,
        });
      } catch (fileError) {
        console.error(`Error processing file ${file.name}:`, fileError);

        // Handle unique constraint violation (P2002) - race condition on s3Key
        // This happens when two concurrent requests pass the findFirst check
        if (
          fileError instanceof Prisma.PrismaClientKnownRequestError &&
          fileError.code === 'P2002'
        ) {
          console.log(`Concurrent duplicate detected for ${file.name}, fetching existing asset`);

          // Clean up the duplicate S3 object
          if (key) {
            try {
              await S3Service.deleteFile(key);
              console.log(`Cleaned up duplicate S3 object: ${key}`);
            } catch (cleanupError) {
              console.error(`Failed to clean up duplicate S3 object ${key}:`, cleanupError);
            }
          }

          // Fetch and return the existing asset
          const existingAsset = await prisma.asset.findFirst({
            where: { s3Key: key }
          });

          if (existingAsset) {
            uploadResults.push({
              id: existingAsset.id,
              name: file.name,
              url: existingAsset.storageUrl,
              size: file.size,
              success: true,
              warning: "File already exists (detected during concurrent upload), returning existing asset",
            });
            continue;
          } else {
            // Edge case: P2002 fired but asset not found (deleted between constraint check and fetch)
            // S3 object already cleaned up above, return error without double-delete
            uploadResults.push({
              name: file.name,
              url: file.url,
              size: file.size,
              success: false,
              error: "Concurrent upload conflict - please retry",
            });
            continue;
          }
        }

        // Clean up orphaned S3 object if transaction failed
        // This prevents orphaned files in S3 when database operations fail
        if (key) {
          try {
            await S3Service.deleteFile(key);
            console.log(`Cleaned up orphaned S3 object: ${key}`);
          } catch (cleanupError) {
            // Log but don't fail - orphaned files can be cleaned up later
            console.error(`Failed to clean up S3 object ${key}:`, cleanupError);
          }
        }

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

    if (
      projectSettings.autoInferenceEnabled &&
      projectSettings.activeModelId &&
      autoInferenceAssetIds.length > 0
    ) {
      try {
        const model = await prisma.trainedModel.findFirst({
          where: {
            id: projectSettings.activeModelId,
            teamId: projectSettings.teamId,
          },
          select: {
            id: true,
            name: true,
            version: true,
            status: true,
          },
        });

        if (!model) {
          autoInferenceSummary = {
            started: false,
            error: "Active YOLO model not found for this project.",
          };
        } else if (!["READY", "ACTIVE"].includes(model.status)) {
          autoInferenceSummary = {
            started: false,
            error: `Active YOLO model status ${model.status} is not ready for inference.`,
          };
        } else {
          const modelName = formatModelId(model.name, model.version);
          const processingJob = await prisma.processingJob.create({
            data: {
              projectId,
              type: "AI_DETECTION",
              status: "PENDING",
              progress: 0,
              config: {
                modelId: model.id,
                modelName,
                confidence: AUTO_INFERENCE_CONFIDENCE,
                saveDetections: true,
                totalImages: autoInferenceAssetIds.length,
                processedImages: 0,
                detectionsFound: 0,
                skippedImages: autoInferenceSkipped,
                skippedReason: "missing_gps_or_dimensions",
                duplicateImages: 0,
                source: "auto_upload",
              },
            },
          });

          if (autoInferenceAssetIds.length <= MAX_SYNC_INFERENCE_IMAGES) {
            const result = await processInferenceJob({
              jobId: processingJob.id,
              projectId,
              modelId: model.id,
              modelName,
              assetIds: autoInferenceAssetIds,
              confidence: AUTO_INFERENCE_CONFIDENCE,
              saveDetections: true,
              skippedImages: autoInferenceSkipped,
              duplicateImages: 0,
              skippedReason: "missing_gps_or_dimensions",
            });

            autoInferenceSummary = {
              started: true,
              status: "completed",
              jobId: processingJob.id,
              totalImages: autoInferenceAssetIds.length,
              processedImages: result.processedImages,
              detectionsFound: result.detectionsFound,
              skippedImages: autoInferenceSkipped,
            };
          } else {
            const redisAvailable = await checkRedisConnection();
            if (!redisAvailable) {
              await prisma.processingJob.update({
                where: { id: processingJob.id },
                data: {
                  status: "FAILED",
                  errorMessage:
                    "Redis unavailable - batch too large for auto inference",
                },
              });
              autoInferenceSummary = {
                started: false,
                error:
                  "Redis unavailable - batch too large for auto inference.",
              };
            } else {
              await enqueueInferenceJob({
                processingJobId: processingJob.id,
                modelId: model.id,
                modelName,
                projectId,
                assetIds: autoInferenceAssetIds,
                confidence: AUTO_INFERENCE_CONFIDENCE,
                saveDetections: true,
              });
              autoInferenceSummary = {
                started: true,
                status: "queued",
                jobId: processingJob.id,
                totalImages: autoInferenceAssetIds.length,
                skippedImages: autoInferenceSkipped,
              };
            }
          }
        }
      } catch (autoError) {
        const message =
          autoError instanceof Error ? autoError.message : "Unknown error";
        autoInferenceSummary = {
          started: false,
          error: message,
        };
      }
    }

    // Aggregate warnings for the response summary
    const filesWithWarnings = uploadResults.filter(
      (file) => file.success && file.warnings && file.warnings.length > 0
    );

    return NextResponse.json({
      message: `Processed ${uploadResults.filter((file) => file.success).length} of ${files.length} files`,
      files: uploadResults,
      summary: {
        successful: uploadResults.filter((file) => file.success).length,
        failed: uploadResults.filter((file) => !file.success).length,
        withWarnings: filesWithWarnings.length,
        warningTypes: filesWithWarnings.length > 0
          ? [...new Set(filesWithWarnings.flatMap((f) => f.warnings || []))]
          : [],
      },
      autoInference: autoInferenceSummary,
    });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to process uploads. Please try again." },
      { status: 500 },
    );
  }
}
