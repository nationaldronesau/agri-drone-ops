/**
 * Training Model Activation API Route
 *
 * POST /api/training/models/[id]/activate - Activate a model on EC2 and mark active in DB
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';
import { yoloService, formatModelId } from '@/lib/services/yolo';
import { sam3Orchestrator } from '@/lib/services/sam3-orchestrator';
import { ModelStatus } from '@prisma/client';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;
    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const projectAccess = await checkProjectAccess(projectId);
    if (!projectAccess.hasAccess || !projectAccess.teamId) {
      return NextResponse.json(
        { error: projectAccess.error || 'Access denied' },
        { status: 403 }
      );
    }

    const model = await prisma.trainedModel.findFirst({
      where: {
        id: params.id,
        teamId: projectAccess.teamId,
      },
      select: {
        id: true,
        name: true,
        version: true,
        teamId: true,
        status: true,
      },
    });

    if (!model) {
      return NextResponse.json({ error: 'Model not found' }, { status: 404 });
    }

    const modelId = formatModelId(model.name, model.version);

    try {
      const gpuResult = await sam3Orchestrator.ensureGPUAvailable();
      if (!gpuResult.success) {
        return NextResponse.json(
          { error: `Cannot activate model: ${gpuResult.message}` },
          { status: 503 }
        );
      }
      await yoloService.activateModel(modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to activate model';
      return NextResponse.json(
        { error: 'Failed to activate model on EC2', details: message },
        { status: 502 }
      );
    }

    const [, updatedModel] = await prisma.$transaction([
      prisma.project.update({
        where: { id: projectId },
        data: { activeModelId: model.id },
      }),
      prisma.trainedModel.update({
        where: { id: model.id },
        data: {
          isActive: true,
          status: ModelStatus.ACTIVE,
          lastUsedAt: new Date(),
        },
      }),
    ]);

    return NextResponse.json({ success: true, model: updatedModel, projectId });
  } catch (error) {
    console.error('Error activating model:', error);
    return NextResponse.json(
      { error: 'Failed to activate model' },
      { status: 500 }
    );
  }
}
