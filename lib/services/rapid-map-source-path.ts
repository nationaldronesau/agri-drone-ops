import { assertValidS3Key, S3Service } from "@/lib/services/s3";

export function assertRapidMapProjectS3Prefix(
  sourcePath: string,
  projectId: string
): void {
  assertValidS3Key(sourcePath, "Rapid Map source prefix");

  const projectPrefix = `${S3Service.environmentSegment}/${projectId}/`;
  if (!sourcePath.startsWith(projectPrefix)) {
    throw new Error(
      `Rapid Map S3 source must be under the current project prefix: ${projectPrefix}`
    );
  }
}
