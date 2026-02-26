import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { logStructured } from '@/lib/utils/structured-log';
import { mapAnnotationClassError } from '@/lib/api/annotation-classes-errors';

const CLASS_ID_REGEX = /^c[a-z0-9]{24,}$/i;

async function checkClassAccess(classId: string, userId: string) {
  const accessProbe = await prisma.annotationClass.findUnique({
    where: { id: classId },
    select: {
      project: {
        select: {
          team: {
            select: {
              members: {
                where: { userId },
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });

  if (!accessProbe) {
    return { ok: false, status: 404, error: 'Class not found' };
  }

  const hasAccess = accessProbe.project.team.members.length > 0;
  if (!hasAccess) {
    return { ok: false, status: 403, error: 'Access denied' };
  }

  return { ok: true };
}

function mapClassErrorResponse(operation: 'PUT' | 'DELETE', classId: string, error: unknown): NextResponse {
  const mapped = mapAnnotationClassError(error);
  logStructured('error', 'annotation_classes.item_failed', {
    operation,
    classId,
    status: mapped.status,
    errorCode: mapped.code,
    error,
  });
  return NextResponse.json(
    { error: mapped.message, code: mapped.code },
    { status: mapped.status }
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (!CLASS_ID_REGEX.test(id)) {
    return NextResponse.json({ error: 'Invalid class ID format' }, { status: 400 });
  }

  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const access = await checkClassAccess(id, auth.userId);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    const body = await request.json();
    if (!body || typeof body !== 'object') {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
    }

    const { name, color, sortOrder } = body as {
      name?: unknown;
      color?: unknown;
      sortOrder?: unknown;
    };

    const data: Record<string, unknown> = {};
    if (name !== undefined) {
      if (typeof name !== 'string' || !name.trim()) {
        return NextResponse.json({ error: 'name must be a non-empty string' }, { status: 400 });
      }
      data.name = name.trim();
    }
    if (color !== undefined) {
      if (typeof color !== 'string' || !color.trim()) {
        return NextResponse.json({ error: 'color must be a non-empty string' }, { status: 400 });
      }
      data.color = color;
    }
    if (sortOrder !== undefined) {
      if (!Number.isInteger(sortOrder)) {
        return NextResponse.json({ error: 'sortOrder must be an integer' }, { status: 400 });
      }
      data.sortOrder = sortOrder;
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const updated = await prisma.annotationClass.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  } catch (error) {
    return mapClassErrorResponse('PUT', id, error);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  void request;
  const { id } = await params;
  if (!CLASS_ID_REGEX.test(id)) {
    return NextResponse.json({ error: 'Invalid class ID format' }, { status: 400 });
  }

  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
    }

    const access = await checkClassAccess(id, auth.userId);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status });
    }

    await prisma.annotationClass.delete({ where: { id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return mapClassErrorResponse('DELETE', id, error);
  }
}
