import { describe, expect, it } from "vitest";
import {
  buildAssetSetMetadataCsv,
  RapidMapMetadataAsset,
} from "@/lib/services/rapid-map-asset-metadata";

function asset(
  overrides: Partial<RapidMapMetadataAsset> & Pick<RapidMapMetadataAsset, "id" | "fileName" | "s3Key">
): RapidMapMetadataAsset {
  return {
    metadata: null,
    gpsLatitude: -27,
    gpsLongitude: 153,
    altitude: 100,
    gimbalRoll: null,
    gimbalPitch: null,
    gimbalYaw: null,
    imageWidth: null,
    imageHeight: null,
    ...overrides,
  };
}

describe("buildAssetSetMetadataCsv", () => {
  it("writes runner-compatible rows and reports assets missing required GPS metadata", () => {
    const result = buildAssetSetMetadataCsv([
      asset({
        id: "asset-1",
        fileName: "IMG_001.JPG",
        s3Key: "teams/team-1/IMG_001.JPG",
        metadata: { RelativeAltitude: 80, FlightYawDegree: 42 },
        gimbalYaw: 43,
        gimbalPitch: -90,
        gimbalRoll: 0,
        imageWidth: 5472,
        imageHeight: 3648,
      }),
      asset({
        id: "asset-2",
        fileName: "IMG_002.JPG",
        s3Key: "teams/team-1/IMG_002.JPG",
        gpsLatitude: -27.1,
        gpsLongitude: 153.1,
        altitude: 111,
        gimbalYaw: -178,
        gimbalPitch: -89.5,
        gimbalRoll: 0.2,
        imageWidth: 4000,
        imageHeight: 3000,
      }),
      asset({
        id: "asset-3",
        fileName: "IMG_003.JPG",
        s3Key: "teams/team-1/IMG_003.JPG",
        gpsLongitude: null,
      }),
    ]);

    expect(result.csv).toBe(
      [
        "filename,lat,lon,AbsoluteAltitude,RelativeAltitude,FlightYawDegree,GimbalYawDegree,GimbalPitchDegree,GimbalRollDegree,ImageWidth,ImageLength",
        "IMG_001.JPG,-27,153,100,80,42,43,-90,0,5472,3648",
        "IMG_002.JPG,-27.1,153.1,111,,,-178,-89.5,0.2,4000,3000",
        "",
      ].join("\n")
    );
    expect(result.assetObjects).toEqual([
      { s3Key: "teams/team-1/IMG_001.JPG", filename: "IMG_001.JPG" },
      { s3Key: "teams/team-1/IMG_002.JPG", filename: "IMG_002.JPG" },
    ]);
    expect(result.excludedAssets).toEqual([
      {
        id: "asset-3",
        fileName: "IMG_003.JPG",
        missingFields: ["gpsLongitude"],
      },
    ]);
  });
});
