/**
 * Roboflow Projects API
 *
 * GET  - List all projects (from cache, with optional sync)
 * POST - Create a new project
 */
import { NextRequest, NextResponse } from 'next/server';
import { roboflowProjectsService } from '@/lib/services/roboflow-projects';

export async function GET(request: NextRequest) {
  try {
    // Check if service is configured
    if (!roboflowProjectsService.isConfigured()) {
      return NextResponse.json(
        { error: roboflowProjectsService.getConfigError() },
        { status: 503 }
      );
    }

    // Check if sync is requested
    const { searchParams } = new URL(request.url);
    const sync = searchParams.get('sync') === 'true';

    let projects;
    if (sync) {
      // Force sync from Roboflow API
      projects = await roboflowProjectsService.syncProjects();
    } else {
      // Get from cache first, sync if empty
      projects = await roboflowProjectsService.getCachedProjects();
      if (projects.length === 0) {
        // No cached projects, sync from Roboflow
        projects = await roboflowProjectsService.syncProjects();
      }
    }

    return NextResponse.json({
      projects,
      synced: sync || projects.length === 0,
    });
  } catch (error) {
    console.error('Error listing Roboflow projects:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list projects' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check if service is configured
    if (!roboflowProjectsService.isConfigured()) {
      return NextResponse.json(
        { error: roboflowProjectsService.getConfigError() },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { name, type } = body;

    // Validate required fields
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json(
        { error: 'Project name is required' },
        { status: 400 }
      );
    }

    if (!type || !['object-detection', 'instance-segmentation'].includes(type)) {
      return NextResponse.json(
        { error: 'Type must be "object-detection" or "instance-segmentation"' },
        { status: 400 }
      );
    }

    // Create the project
    const project = await roboflowProjectsService.createProject({
      name: name.trim(),
      type,
      annotation: body.annotation,
      license: body.license,
    });

    return NextResponse.json(project, { status: 201 });
  } catch (error) {
    console.error('Error creating Roboflow project:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to create project' },
      { status: 500 }
    );
  }
}
