import prisma from "@/lib/db";
import {
  buildAssetSetMetadataCsv,
  ExcludedRapidMapMetadataAsset,
  RapidMapAssetObject,
} from "@/lib/services/rapid-map-asset-metadata";

export class RapidMapAssetSetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RapidMapAssetSetValidationError";
  }
}

export interface ResolvedRapidMapAssetSet {
  sourceAssetIds: string[];
  assetObjects: RapidMapAssetObject[];
  metadataCsv: string;
  excludedAssets: ExcludedRapidMapMetadataAsset[];
}

export async function resolveRapidMapAssetSet(
  teamId: string,
  requestedAssetIds: string[]
): Promise<ResolvedRapidMapAssetSet> {
  const sourceAssetIds = [...new Set(requestedAssetIds)];
  if (sourceAssetIds.length === 0) {
    throw new RapidMapAssetSetValidationError("Rapid Map run is missing source asset ids.");
  }

  const assets = await prisma.asset.findMany({
    where: {
      id: { in: sourceAssetIds },
      project: { teamId },
    },
    select: {
      id: true,
      fileName: true,
      s3Key: true,
      metadata: true,
      gpsLatitude: true,
      gpsLongitude: true,
      altitude: true,
      gimbalRoll: true,
      gimbalPitch: true,
      gimbalYaw: true,
      imageWidth: true,
      imageHeight: true,
    },
  });

  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const unavailableIds = sourceAssetIds.filter((id) => !assetById.has(id));
  if (unavailableIds.length > 0) {
    throw new RapidMapAssetSetValidationError(
      `Rapid Map asset ids are not available to this team: ${unavailableIds.join(", ")}`
    );
  }

  const orderedAssets = sourceAssetIds.map((id) => assetById.get(id)!);
  let metadata;
  try {
    metadata = buildAssetSetMetadataCsv(orderedAssets);
  } catch (error) {
    throw new RapidMapAssetSetValidationError(
      error instanceof Error ? error.message : "Rapid Map asset metadata is invalid."
    );
  }

  if (metadata.assetObjects.length < 3) {
    const excluded = metadata.excludedAssets
      .map(
        (asset) =>
          `${asset.id} (${asset.fileName}): ${asset.missingFields.join(", ")}`
      )
      .join("; ");
    throw new RapidMapAssetSetValidationError(
      `ASSET_SET requires at least 3 assets with GPS latitude, GPS longitude, and altitude. Missing metadata: ${excluded || "no eligible assets"}`
    );
  }

  const filenameCounts = new Map<string, number>();
  for (const asset of metadata.assetObjects) {
    filenameCounts.set(asset.filename, (filenameCounts.get(asset.filename) || 0) + 1);
  }
  const duplicateFilenames = [...filenameCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([filename]) => filename);
  if (duplicateFilenames.length > 0) {
    throw new RapidMapAssetSetValidationError(
      `ASSET_SET contains duplicate image filenames: ${duplicateFilenames.join(", ")}`
    );
  }

  const assetIdByS3Key = new Map(
    orderedAssets.map((asset) => [asset.s3Key, asset.id])
  );

  return {
    sourceAssetIds: metadata.assetObjects.map((asset) => assetIdByS3Key.get(asset.s3Key)!),
    assetObjects: metadata.assetObjects,
    metadataCsv: metadata.csv,
    excludedAssets: metadata.excludedAssets,
  };
}
