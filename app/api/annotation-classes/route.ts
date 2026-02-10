import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { checkProjectAccess } from '@/lib/auth/api-auth';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const projectId = searchParams.get('projectId');

  if (!projectId) {
    return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
  }

  const auth = await checkProjectAccess(projectId);
  if (!auth.hasAccess) {
    return NextResponse.json({ error: auth.error || 'Access denied' }, { status: auth.authenticated ? 403 : 401 });
  }

  const classes = await prisma.annotationClass.findMany({
    where: { projectId },
    orderBy: { sortOrder: 'asc' },
  });

  return NextResponse.json(classes);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { projectId, name, color, sortOrder } = body;

  if (!projectId || !name) {
    return NextResponse.json({ error: 'projectId and name are required' }, { status: 400 });
  }

  const auth = await checkProjectAccess(projectId);
  if (!auth.hasAccess) {
    return NextResponse.json({ error: auth.error || 'Access denied' }, { status: auth.authenticated ? 403 : 401 });
  }

  // Get next sortOrder if not provided
  let order = sortOrder;
  if (order === undefined || order === null) {
    const maxOrder = await prisma.annotationClass.findFirst({
      where: { projectId },
      orderBy: { sortOrder: 'desc' },
      select: { sortOrder: true },
    });
    order = (maxOrder?.sortOrder ?? -1) + 1;
  }

  try {
    const created = await prisma.annotationClass.create({
      data: {
        projectId,
        name: name.trim(),
        color: color || '#9ca3af',
        sortOrder: order,
      },
    });
    return NextResponse.json(created, { status: 201 });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return NextResponse.json({ error: 'A class with this name already exists in this project' }, { status: 409 });
    }
    throw err;
  }
}
