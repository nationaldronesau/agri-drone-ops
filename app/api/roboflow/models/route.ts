import { NextRequest, NextResponse } from 'next/server';

const ROBOFLOW_API_KEY = process.env.ROBOFLOW_API_KEY;
const ROBOFLOW_WORKSPACE = process.env.ROBOFLOW_WORKSPACE;

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
export async function GET(request: NextRequest) {
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
    // First, get all projects in the workspace
    const workspaceUrl = `https://api.roboflow.com/${ROBOFLOW_WORKSPACE}?api_key=${ROBOFLOW_API_KEY}`;
    const workspaceResponse = await fetch(workspaceUrl, {
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(30000),
    });

    if (!workspaceResponse.ok) {
      const error = await workspaceResponse.text();
      throw new Error(`Failed to fetch workspace: ${workspaceResponse.status} - ${error}`);
    }

    const workspaceData = await workspaceResponse.json();
    const projects: RoboflowProjectResponse[] = workspaceData.projects || [];

    // For each project, get detailed info including versions
    const models: RoboflowModel[] = [];

    for (const project of projects) {
      try {
        const projectUrl = `https://api.roboflow.com/${ROBOFLOW_WORKSPACE}/${project.id}?api_key=${ROBOFLOW_API_KEY}`;
        const projectResponse = await fetch(projectUrl, {
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
        });

        if (!projectResponse.ok) {
          console.warn(`Failed to fetch project ${project.id}`);
          continue;
        }

        const projectData: RoboflowProjectResponse = await projectResponse.json();
        const versions = projectData.versions || [];

        // Find versions that have a trained model
        for (const version of versions) {
          if (version.model?.endpoint) {
            const classes = version.classes
              ? Object.keys(version.classes)
              : (projectData.classes ? Object.keys(projectData.classes) : []);

            models.push({
              id: `${project.id}-v${version.version}`,
              projectId: project.id,
              projectName: projectData.name || project.id,
              version: version.version,
              type: projectData.type || 'object-detection',
              endpoint: version.model.endpoint,
              classes,
              map: version.model.map,
              createdAt: new Date(version.created * 1000).toISOString(),
            });
          }
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
    console.error('Error fetching models:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: 'Failed to fetch detection models. Please try again.' },
      { status: 500 }
    );
  }
}
