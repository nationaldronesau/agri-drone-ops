export function getProjectIdFromS3Key(key: string): string | null {
  const segments = key.split('/');
  if (segments.length < 2) {
    return null;
  }

  const projectId = segments[1];
  return projectId ? projectId : null;
}
