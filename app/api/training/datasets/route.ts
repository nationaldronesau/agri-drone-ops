/**
 * Training Datasets API Routes
 *
 * POST /api/training/datasets - Create dataset from annotations
 * GET /api/training/datasets - List datasets
 */
import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { datasetPreparation } from '@/lib/services/dataset-preparation';
import { getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import { checkRateLimit } from '@/lib/utils/security';

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const rateLimitKey = `training-datasets:${auth.userId}`;
    const rateLimit = checkRateLimit(rateLimitKey, { maxRequests: 5, windowMs: 60000 });
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

    const body = await request.json();
    const {
      name,
      description,
      projectId,
      sessionIds,
      classes,
      splitRatio,
      includeAIDetections = true,
      includeManualAnnotations = true,
      minConfidence = 0.5,
    } = body;

    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 });
    }

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    if (!classes || !Array.isArray(classes) || classes.length === 0) {
      return NextResponse.json(
        { error: 'classes array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (splitRatio) {
      const total = (splitRatio.train ?? 0) + (splitRatio.val ?? 0) + (splitRatio.test ?? 0);
      if (total <= 0) {
        return NextResponse.json({ error: 'splitRatio must have positive values' }, { status: 400 });
      }
    }

    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        team: {
          members: {
            some: { userId: auth.userId },
          },
        },
      },
      select: {
        id: true,
        teamId: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: 'Project not found or access denied' },
        { status: 403 }
      );
    }

    if (sessionIds && sessionIds.length > 0) {
      const sessionCount = await prisma.annotationSession.count({
        where: {
          id: { in: sessionIds },
          asset: { projectId },
        },
      });
      if (sessionCount !== sessionIds.length) {
        return NextResponse.json(
          { error: 'One or more sessionIds do not belong to the project' },
          { status: 400 }
        );
      }
    }

    const result = await datasetPreparation.prepareDataset(project.teamId, name, {
      projectId,
      sessionIds,
      classes,
      splitRatio: splitRatio || { train: 0.7, val: 0.2, test: 0.1 },
      includeAIDetections,
      includeManualAnnotations,
      minConfidence,
      createdById: auth.userId,
    });

    if (description) {
      await prisma.trainingDataset.update({
        where: { id: result.datasetId },
        data: { description },
      });
    }

    return NextResponse.json({
      success: true,
      dataset: {
        id: result.datasetId,
        name,
        description,
        s3Path: result.s3Path,
        imageCount: result.imageCount,
        labelCount: result.labelCount,
        trainCount: result.trainCount,
        valCount: result.valCount,
        testCount: result.testCount,
        classes: result.classes,
      },
    });
  } catch (error) {
    console.error('Error creating dataset:', error);
    const message = error instanceof Error ? error.message : 'Failed to create dataset';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get('teamId');
    const projectId = searchParams.get('projectId');
    const limit = parseInt(searchParams.get('limit') || '20', 10);
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    const membership = await getUserTeamIds();
    if (!membership.authenticated || !membership.userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (membership.teamIds.length === 0) {
      return NextResponse.json({ error: 'No team access' }, { status: 403 });
    }

    const teamIds = teamId ? [teamId] : membership.teamIds;
    if (teamId && !membership.teamIds.includes(teamId)) {
      return NextResponse.json({ error: 'Access denied' }, { status: 403 });
    }

    if (projectId) {
      const project = await prisma.project.findFirst({
        where: { id: projectId, teamId: { in: teamIds } },
        select: { id: true },
      });
      if (!project) {
        return NextResponse.json({ error: 'Project not found or access denied' }, { status: 403 });
      }
    }

    const where: Record<string, unknown> = {
      teamId: { in: teamIds },
    };
    if (projectId) {
      where.projectId = projectId;
    }

    const [datasets, total] = await Promise.all([
      prisma.trainingDataset.findMany({
        where,
        include: {
          project: {
            select: {
              id: true,
              name: true,
            },
          },
          trainingJobs: {
            select: {
              id: true,
              status: true,
            },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.trainingDataset.count({ where }),
    ]);

    const formatted = datasets.map((dataset) => ({
      ...dataset,
      classes: JSON.parse(dataset.classes),
      augmentationConfig: dataset.augmentationConfig
        ? JSON.parse(dataset.augmentationConfig)
        : null,
      latestJob: dataset.trainingJobs[0] || null,
    }));

    return NextResponse.json({
      datasets: formatted,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error listing datasets:', error);
    return NextResponse.json({ error: 'Failed to list datasets' }, { status: 500 });
  }
}
