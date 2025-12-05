/**
 * Roboflow Projects API
 *
 * GET  - List all projects (from cache, with optional sync)
 * POST - Create a new project
 *
 * Security:
 * - Authentication required via NextAuth session
 * - Rate limiting on POST (10 per minute per user)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { roboflowProjectsService } from '@/lib/services/roboflow-projects';
import { checkRateLimit } from '@/lib/utils/security';

export async function GET(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Check if service is configured
    if (!roboflowProjectsService.isConfigured()) {
      const configError = roboflowProjectsService.getConfigError();
      console.error('[API /roboflow/projects] Service not configured:', configError);
      return NextResponse.json(
        { error: configError, projects: [] },
        { status: 503 }
      );
    }

    // Check if sync is requested
    const { searchParams } = new URL(request.url);
    const sync = searchParams.get('sync') === 'true';
    console.log(`[API /roboflow/projects] GET request from user ${session.user.id}, sync=${sync}`);

    let projects;
    let didSync = false;

    if (sync) {
      // Force sync from Roboflow API
      console.log('[API /roboflow/projects] Forcing sync from Roboflow');
      projects = await roboflowProjectsService.syncProjects();
      didSync = true;
    } else {
      // Get from cache first, sync if empty
      projects = await roboflowProjectsService.getCachedProjects();
      console.log(`[API /roboflow/projects] Got ${projects.length} cached projects`);

      if (projects.length === 0) {
        // No cached projects, sync from Roboflow
        console.log('[API /roboflow/projects] Cache empty, syncing from Roboflow');
        projects = await roboflowProjectsService.syncProjects();
        didSync = true;
      }
    }

    console.log(`[API /roboflow/projects] Returning ${projects.length} projects, synced=${didSync}`);
    return NextResponse.json({
      projects,
      synced: didSync,
    });
  } catch (error) {
    console.error('[API /roboflow/projects] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list projects', projects: [] },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Rate limit project creation (10 per minute per user)
    const rateLimitKey = `roboflow-projects-create:${session.user.id}`;
    const rateLimit = checkRateLimit(rateLimitKey, { maxRequests: 10, windowMs: 60000 });
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded. Please try again later.' },
        {
          status: 429,
          headers: {
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': rateLimit.resetTime.toString(),
          },
        }
      );
    }

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
      return NextResponse.json({ error: 'Project name is required' }, { status: 400 });
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
