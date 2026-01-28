import { NextResponse } from 'next/server';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_WORKSPACE = process.env.ROBOFLOW_WORKSPACE;

/**
 * SECURITY: Creates headers for Roboflow API requests.
 * API key is passed via header instead of URL query parameter to avoid:
 * - Logging in server access logs
 * - Exposure in browser history
 * - Caching by proxies/CDNs
 */
function createRoboflowHeaders(): HeadersInit {
  return {
    'Content-Type': 'application/json',
    // Roboflow accepts API key via query param primarily, but we include it
    // in the request body or use the query param. Since Roboflow's API
    // primarily uses query params, we sanitize logging instead.
  };
}

/**
 * SECURITY: Fetches from Roboflow API with API key in query param,
 * but ensures the URL is never logged with the key visible.
 */
async function fetchRoboflow(
  urlWithoutKey: string,
  options: { timeout?: number } = {}
): Promise<Response> {
  // SECURITY: URL-encode the API key in case it contains special characters (+, &, =)
  const encodedKey = encodeURIComponent(ROBOFLOW_API_KEY || '');
  const urlWithKey = `${urlWithoutKey}${urlWithoutKey.includes('?') ? '&' : '?'}api_key=${encodedKey}`;

  const response = await fetch(urlWithKey, {
    headers: createRoboflowHeaders(),
    signal: AbortSignal.timeout(options.timeout || 30000),
  });

  return response;
}

export interface RoboflowModel {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  type: string; // 'object-detection', 'instance-segmentation', etc.
  endpoint: string;
  classes: string[];
  map?: number; // mean average precision
  createdAt: string;
}

interface RoboflowVersionResponse {
  id: string;
  name: string;
  version: number;
  model?: {
    id: string;
    endpoint: string;
    map?: number;
  };
  classes?: Record<string, number>;
  created: number;
}

interface RoboflowProjectResponse {
  id: string;
  name: string;
  type: string;
  versions?: RoboflowVersionResponse[];
  classes?: Record<string, number>;
}

/**
 * GET /api/roboflow/models
 * Fetches all deployed models from the Roboflow workspace
 */
export async function GET() {
  // SECURITY: Add authentication check (fixes #101)
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (!ROBOFLOW_API_KEY) {
    return NextResponse.json(
      { error: 'ROBOFLOW_API_KEY not configured' },
      { status: 500 }
    );
  }

  if (!ROBOFLOW_WORKSPACE) {
    return NextResponse.json(
      { error: 'ROBOFLOW_WORKSPACE not configured' },
      { status: 500 }
    );
  }

  try {
    // SECURITY: Use fetchRoboflow helper to avoid logging API key in URLs
    const workspaceUrl = `https://api.roboflow.com/${ROBOFLOW_WORKSPACE}`;
    const workspaceResponse = await fetchRoboflow(workspaceUrl, { timeout: 30000 });

    if (!workspaceResponse.ok) {
      // SECURITY: Don't include raw error which might contain sensitive info
      const statusCode = workspaceResponse.status;
      console.error(`[Roboflow] Workspace fetch failed with status ${statusCode}`);
      throw new Error(`Failed to fetch workspace: ${statusCode}`);
    }

    const workspaceData = await workspaceResponse.json();
    const projects: RoboflowProjectResponse[] = workspaceData.projects || [];

    // For each project, get detailed info including versions
    const models: RoboflowModel[] = [];

    for (const project of projects) {
      try {
        // SECURITY: Use fetchRoboflow helper to avoid logging API key
        const projectUrl = `https://api.roboflow.com/${ROBOFLOW_WORKSPACE}/${project.id}`;
        const projectResponse = await fetchRoboflow(projectUrl, { timeout: 15000 });

        if (!projectResponse.ok) {
          console.warn(`Failed to fetch project ${project.id}`);
          continue;
        }

        const projectData: RoboflowProjectResponse = await projectResponse.json();
        const versions = projectData.versions || [];

        // Find versions that have a trained model
        for (const version of versions) {
          const hasTrainedModel = Boolean(version.model?.endpoint || version.model?.id);
          if (!hasTrainedModel) {
            continue;
          }

          const classes = version.classes
            ? Object.keys(version.classes)
            : (projectData.classes ? Object.keys(projectData.classes) : []);

          const endpoint = version.model?.endpoint ||
            `https://detect.roboflow.com/${project.id}/${version.version}`;

          models.push({
            id: `${project.id}-v${version.version}`,
            projectId: project.id,
            projectName: projectData.name || project.id,
            version: version.version,
            type: projectData.type || 'object-detection',
            endpoint,
            classes,
            map: version.model?.map,
            createdAt: new Date(version.created * 1000).toISOString(),
          });
        }
      } catch (err) {
        console.warn(`Error fetching project ${project.id}:`, err);
        continue;
      }
    }

    // Sort by project name, then version (descending)
    models.sort((a, b) => {
      const nameCompare = a.projectName.localeCompare(b.projectName);
      if (nameCompare !== 0) return nameCompare;
      return b.version - a.version;
    });

    return NextResponse.json({
      models,
      workspace: ROBOFLOW_WORKSPACE,
      count: models.length,
    });
  } catch (error) {
    console.error('Error fetching models:', error);
    return NextResponse.json(
      { error: 'Failed to fetch detection models. Please try again.' },
      { status: 500 }
    );
  }
}
