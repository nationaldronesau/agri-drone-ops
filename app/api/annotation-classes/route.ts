import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';
import { logStructured } from '@/lib/utils/structured-log';
import { mapAnnotationClassError } from '@/lib/api/annotation-classes-errors';

const PROJECT_ID_REGEX = /^c[a-z0-9]{24,}$/i;

function toAccessFailureResponse(projectId: string, operation: 'GET' | 'POST', auth: Awaited<ReturnType<typeof checkProjectAccess>>) {
  if (!auth.authenticated) {
    return NextResponse.json({ error: auth.error || 'Authentication required' }, { status: 401 });
  }

  // `checkProjectAccess` returns this message when auth/db checks fail transiently.
  // Return 503 instead of access-denied semantics to keep failures actionable.
  if (auth.error === 'Failed to verify project access') {
    logStructured('warn', 'annotation_classes.access_check_unavailable', {
      operation,
      projectId,
      error: auth.error,
    });
    return NextResponse.json(
      {
        error: 'Annotation classes temporarily unavailable',
        code: 'ANNOTATION_CLASSES_AUTH_UNAVAILABLE',
      },
      { status: 503 }
    );
  }

  return NextResponse.json({ error: auth.error || 'Access denied' }, { status: 403 });
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }
  if (!PROJECT_ID_REGEX.test(projectId)) {
    return NextResponse.json({ error: 'Invalid project ID format' }, { status: 400 });
  }

  try {
    const auth = await checkProjectAccess(projectId);
    if (!auth.hasAccess) {
      return toAccessFailureResponse(projectId, 'GET', auth);
    }

    const classes = await prisma.annotationClass.findMany({
      where: { projectId },
      orderBy: { sortOrder: 'asc' },
    });

    return NextResponse.json(classes);
  } catch (error) {
    const mapped = mapAnnotationClassError(error);
    logStructured('error', 'annotation_classes.get_failed', {
      projectId,
      status: mapped.status,
      errorCode: mapped.code,
      error,
    });
    return NextResponse.json(
      { error: mapped.message, code: mapped.code },
      { status: mapped.status }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }
    const { projectId, name, color, sortOrder } = body as {
      projectId?: unknown;
      name?: unknown;
      color?: unknown;
      sortOrder?: unknown;
    };

    if (typeof projectId !== 'string' || !projectId || typeof name !== 'string' || !name.trim()) {
      return NextResponse.json({ error: 'projectId and name are required' }, { status: 400 });
    }
    if (!PROJECT_ID_REGEX.test(projectId)) {
      return NextResponse.json({ error: 'Invalid project ID format' }, { status: 400 });
    }

    if (sortOrder !== undefined && sortOrder !== null && !Number.isInteger(sortOrder)) {
      return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 });
    }

    const auth = await checkProjectAccess(projectId);
    if (!auth.hasAccess) {
      return toAccessFailureResponse(projectId, 'POST', auth);
    }

    // Get next sortOrder if not provided
    let order = sortOrder as number | undefined | null;
    if (order === undefined || order === null) {
      const maxOrder = await prisma.annotationClass.findFirst({
        where: { projectId },
        orderBy: { sortOrder: 'desc' },
        select: { sortOrder: true },
      });
      order = (maxOrder?.sortOrder ?? -1) + 1;
    }

    const created = await prisma.annotationClass.create({
      data: {
        projectId,
        name: name.trim(),
        color: typeof color === 'string' && color ? color : '#9ca3af',
        sortOrder: order,
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (error) {
    const mapped = mapAnnotationClassError(error);
    logStructured('error', 'annotation_classes.post_failed', {
      status: mapped.status,
      errorCode: mapped.code,
      error,
    });
    return NextResponse.json(
      { error: mapped.message, code: mapped.code },
      { status: mapped.status }
    );
  }
}
