import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';

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

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const auth = await getAuthenticatedUser();
  if (!auth.authenticated || !auth.userId) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 });
  }

  const access = await checkClassAccess(id, auth.userId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const body = await request.json();
  const { name, color, sortOrder } = body;

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name.trim();
  if (color !== undefined) data.color = color;
  if (sortOrder !== undefined) data.sortOrder = sortOrder;

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
  }

  try {
    const updated = await prisma.annotationClass.update({
      where: { id },
      data,
    });
    return NextResponse.json(updated);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return NextResponse.json({ error: 'A class with this name already exists in this project' }, { status: 409 });
    }
    throw err;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
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
}
