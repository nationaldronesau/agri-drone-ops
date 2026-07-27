import { describe, expect, it } from "vitest";
import { assertRapidMapProjectS3Prefix } from "@/lib/services/rapid-map-source-path";
import { S3Service } from "@/lib/services/s3";

describe("assertRapidMapProjectS3Prefix", () => {
  const projectId = "project-123";
  const projectPrefix = `${S3Service.environmentSegment}/${projectId}/`;

  it("accepts source folders within the selected project", () => {
    expect(() =>
      assertRapidMapProjectS3Prefix(
        `${projectPrefix}raw-images/flight-1`,
        projectId
      )
    ).not.toThrow();
  });

  it("rejects sibling projects and project-id prefix collisions", () => {
    expect(() =>
      assertRapidMapProjectS3Prefix(
        `${S3Service.environmentSegment}/other-project/raw-images/flight-1`,
        projectId
      )
    ).toThrow(/current project prefix/);

    expect(() =>
      assertRapidMapProjectS3Prefix(
        `${S3Service.environmentSegment}/${projectId}-other/raw-images/flight-1`,
        projectId
      )
    ).toThrow(/current project prefix/);
  });
});
