import path from "path";

export const RAPID_MAP_METADATA_COLUMNS = [
  "filename",
  "lat",
  "lon",
  "AbsoluteAltitude",
  "RelativeAltitude",
  "FlightYawDegree",
  "GimbalYawDegree",
  "GimbalPitchDegree",
  "GimbalRollDegree",
  "ImageWidth",
  "ImageLength",
] as const;

export interface RapidMapMetadataAsset {
  id: string;
  fileName: string;
  s3Key: string | null;
  metadata: unknown;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  altitude: number | null;
  gimbalRoll: number | null;
  gimbalPitch: number | null;
  gimbalYaw: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
}

export interface ExcludedRapidMapMetadataAsset {
  id: string;
  fileName: string;
  missingFields: Array<"gpsLatitude" | "gpsLongitude" | "altitude">;
}

export interface RapidMapAssetObject {
  s3Key: string;
  filename: string;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function metadataNumber(metadata: unknown, keys: string[]): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }

  const record = metadata as Record<string, unknown>;
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }

  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function buildAssetSetMetadataCsv(assets: RapidMapMetadataAsset[]): {
  csv: string;
  assetObjects: RapidMapAssetObject[];
  excludedAssets: ExcludedRapidMapMetadataAsset[];
} {
  const rows: Array<Array<string | number | null | undefined>> = [];
  const assetObjects: RapidMapAssetObject[] = [];
  const excludedAssets: ExcludedRapidMapMetadataAsset[] = [];

  for (const asset of assets) {
    const missingFields: ExcludedRapidMapMetadataAsset["missingFields"] = [];
    if (finiteNumber(asset.gpsLatitude) === undefined) missingFields.push("gpsLatitude");
    if (finiteNumber(asset.gpsLongitude) === undefined) missingFields.push("gpsLongitude");
    if (finiteNumber(asset.altitude) === undefined) missingFields.push("altitude");

    if (missingFields.length > 0) {
      excludedAssets.push({
        id: asset.id,
        fileName: asset.fileName,
        missingFields,
      });
      continue;
    }

    if (!asset.s3Key) {
      throw new Error(`Rapid Map asset ${asset.id} (${asset.fileName}) is missing an S3 key.`);
    }

    const filename = path.basename(asset.s3Key);
    if (!filename) {
      throw new Error(`Rapid Map asset ${asset.id} has an invalid S3 key.`);
    }

    rows.push([
      filename,
      asset.gpsLatitude,
      asset.gpsLongitude,
      asset.altitude,
      metadataNumber(asset.metadata, ["RelativeAltitude", "drone-dji:RelativeAltitude"]),
      metadataNumber(asset.metadata, ["FlightYawDegree", "drone-dji:FlightYawDegree"]),
      asset.gimbalYaw,
      asset.gimbalPitch,
      asset.gimbalRoll,
      asset.imageWidth,
      asset.imageHeight,
    ]);
    assetObjects.push({ s3Key: asset.s3Key, filename });
  }

  const csv = [
    RAPID_MAP_METADATA_COLUMNS.join(","),
    ...rows.map((row) => row.map(csvCell).join(",")),
  ].join("\n") + "\n";

  return { csv, assetObjects, excludedAssets };
}
