/**
 * Roboflow Project Detail API
 *
 * GET - Get a single project with its classes
 */
import { NextRequest, NextResponse } from 'next/server';
import { roboflowProjectsService } from '@/lib/services/roboflow-projects';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Check if service is configured
    if (!roboflowProjectsService.isConfigured()) {
      return NextResponse.json(
        { error: roboflowProjectsService.getConfigError() },
        { status: 503 }
      );
    }

    const project = await roboflowProjectsService.getProjectWithClasses(id);

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json(project);
  } catch (error) {
    console.error('Error getting Roboflow project:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get project' },
      { status: 500 }
    );
  }
}
