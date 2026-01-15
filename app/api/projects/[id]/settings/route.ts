import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const projectAccess = await checkProjectAccess(params.id);
    if (!projectAccess.hasAccess) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const hasAutoInference = typeof body.autoInferenceEnabled === 'boolean';
    if (!hasAutoInference) {
      return NextResponse.json(
        { error: 'autoInferenceEnabled must be a boolean' },
        { status: 400 }
      );
    }

    const updated = await prisma.project.update({
      where: { id: params.id },
      data: {
        autoInferenceEnabled: body.autoInferenceEnabled,
      },
    });

    return NextResponse.json({
      success: true,
      project: {
        id: updated.id,
        autoInferenceEnabled: updated.autoInferenceEnabled,
        activeModelId: updated.activeModelId,
      },
    });
  } catch (error) {
    console.error('Error updating project settings:', error);
    return NextResponse.json(
      { error: 'Failed to update project settings' },
      { status: 500 }
    );
  }
}
