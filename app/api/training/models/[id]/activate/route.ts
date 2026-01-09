/**
 * Training Model Activation API Route
 *
 * POST /api/training/models/[id]/activate - Activate a model on EC2 and mark active in DB
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/api-auth';
import { yoloService, formatModelId } from '@/lib/services/yolo';
import { ModelStatus } from '@prisma/client';

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const model = await prisma.trainedModel.findFirst({
      where: {
        id: params.id,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
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
      await yoloService.activateModel(modelId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to activate model';
      return NextResponse.json(
        { error: 'Failed to activate model on EC2', details: message },
        { status: 502 }
      );
    }

    const [_, updatedModel] = await prisma.$transaction([
      prisma.trainedModel.updateMany({
        where: {
          teamId: model.teamId,
          isActive: true,
          NOT: { id: model.id },
        },
        data: { isActive: false, status: ModelStatus.READY },
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

    return NextResponse.json({ success: true, model: updatedModel });
  } catch (error) {
    console.error('Error activating model:', error);
    return NextResponse.json(
      { error: 'Failed to activate model' },
      { status: 500 }
    );
  }
}
