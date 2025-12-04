/**
 * Roboflow Project Classes API
 *
 * GET  - Get classes for a project (syncs if stale or forceSync=true)
 * POST - Add a new class to the project (local only)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth/config';
import { roboflowProjectsService } from '@/lib/services/roboflow-projects';
import { checkRateLimit } from '@/lib/utils/security';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Check if service is configured
    if (!roboflowProjectsService.isConfigured()) {
      return NextResponse.json(
        { error: roboflowProjectsService.getConfigError() },
        { status: 503 }
      );
    }

    // Check if force sync is requested
    const { searchParams } = new URL(request.url);
    const forceSync = searchParams.get('sync') === 'true';

    const classes = await roboflowProjectsService.getClassesForProject(id, forceSync);

    return NextResponse.json({
      classes,
      synced: forceSync,
    });
  } catch (error) {
    console.error('Error getting Roboflow project classes:', error);

    // Handle project not found specifically
    if (error instanceof Error && error.message === 'Project not found') {
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to get classes' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check authentication
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    // Rate limit class creation (10 per minute per user)
    const rateLimitKey = `roboflow-class:${session.user.id}`;
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
    const { className } = body;

    // Validate className
    if (!className || typeof className !== 'string' || className.trim().length === 0) {
      return NextResponse.json({ error: 'Class name is required' }, { status: 400 });
    }

    // Sanitize class name (lowercase, alphanumeric with hyphens/underscores)
    const sanitizedClassName = className
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');

    if (sanitizedClassName.length === 0) {
      return NextResponse.json(
        { error: 'Class name must contain alphanumeric characters' },
        { status: 400 }
      );
    }

    const newClass = await roboflowProjectsService.addClassToProject(id, sanitizedClassName);

    return NextResponse.json(newClass, { status: 201 });
  } catch (error) {
    console.error('Error adding class to Roboflow project:', error);

    // Handle duplicate class
    if (error instanceof Error && error.message.includes('Unique constraint')) {
      return NextResponse.json(
        { error: 'Class already exists in this project' },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to add class' },
      { status: 500 }
    );
  }
}
