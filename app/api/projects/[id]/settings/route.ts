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
    const hasBackend = typeof body.inferenceBackend === 'string';
    if (!hasAutoInference && !hasBackend) {
      return NextResponse.json(
        { error: 'autoInferenceEnabled or inferenceBackend must be provided' },
        { status: 400 }
      );
    }
    if (hasBackend) {
      const allowed = new Set(['LOCAL', 'ROBOFLOW', 'AUTO']);
      if (!allowed.has(body.inferenceBackend)) {
        return NextResponse.json({ error: 'Invalid inferenceBackend' }, { status: 400 });
      }
    }

    const updated = await prisma.project.update({
      where: { id: params.id },
      data: {
        ...(hasAutoInference ? { autoInferenceEnabled: body.autoInferenceEnabled } : {}),
        ...(hasBackend ? { inferenceBackend: body.inferenceBackend } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      project: {
        id: updated.id,
        autoInferenceEnabled: updated.autoInferenceEnabled,
        activeModelId: updated.activeModelId,
        inferenceBackend: updated.inferenceBackend,
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
