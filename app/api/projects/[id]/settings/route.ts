import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import prisma from '@/lib/db';
import { getAuthenticatedUser, checkProjectAccess } from '@/lib/auth/api-auth';
import { parseFeatureFlags } from '@/lib/utils/feature-flags';

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
    const temporalInsightsValue =
      typeof body?.temporalInsights === 'boolean'
        ? body.temporalInsights
        : body?.features &&
            typeof body.features === 'object' &&
            !Array.isArray(body.features) &&
            typeof (body.features as Record<string, unknown>).temporalInsights === 'boolean'
          ? (body.features as Record<string, boolean>).temporalInsights
          : undefined;
    const hasTemporalInsights = typeof temporalInsightsValue === 'boolean';

    if (!hasAutoInference && !hasBackend && !hasTemporalInsights) {
      return NextResponse.json(
        { error: 'autoInferenceEnabled, inferenceBackend, or features.temporalInsights must be provided' },
        { status: 400 }
      );
    }
    if (hasBackend) {
      const allowed = new Set(['LOCAL', 'ROBOFLOW', 'AUTO']);
      if (!allowed.has(body.inferenceBackend)) {
        return NextResponse.json({ error: 'Invalid inferenceBackend' }, { status: 400 });
      }
    }

    const existingProject = hasTemporalInsights
      ? await prisma.project.findUnique({
          where: { id: params.id },
          select: { features: true },
        })
      : null;
    const mergedFeatures = hasTemporalInsights
      ? ({
          ...parseFeatureFlags(existingProject?.features),
          temporalInsights: temporalInsightsValue,
        } as Prisma.JsonObject)
      : undefined;

    const updated = await prisma.project.update({
      where: { id: params.id },
      data: {
        ...(hasAutoInference ? { autoInferenceEnabled: body.autoInferenceEnabled } : {}),
        ...(hasBackend ? { inferenceBackend: body.inferenceBackend } : {}),
        ...(hasTemporalInsights ? { features: mergedFeatures } : {}),
      },
    });

    return NextResponse.json({
      success: true,
      project: {
        id: updated.id,
        autoInferenceEnabled: updated.autoInferenceEnabled,
        activeModelId: updated.activeModelId,
        inferenceBackend: updated.inferenceBackend,
        features: updated.features,
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
