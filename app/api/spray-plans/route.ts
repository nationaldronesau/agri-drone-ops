import { NextRequest, NextResponse } from 'next/server';
import { SprayPlanStatus } from '@prisma/client';
import prisma from '@/lib/db';
import { checkProjectAccess, getAuthenticatedUser, getUserTeamIds } from '@/lib/auth/api-auth';
import { createSprayPlan } from '@/lib/services/spray-planner';

export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const memberships = await getUserTeamIds();
    if (memberships.dbError) {
      return NextResponse.json({ error: 'Failed to load team memberships' }, { status: 500 });
    }

    if (memberships.teamIds.length === 0) {
      return NextResponse.json({ plans: [], total: 0, limit: 20, offset: 0 });
    }

    const params = request.nextUrl.searchParams;
    const projectId = params.get('projectId');
    const status = params.get('status');
    const limit = Math.max(1, Math.min(100, parseInt(params.get('limit') || '20', 10) || 20));
    const offset = Math.max(0, parseInt(params.get('offset') || '0', 10) || 0);

    if (projectId) {
      const access = await checkProjectAccess(projectId);
      if (!access.hasAccess) {
        return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
      }
    }

    const where: Record<string, unknown> = {
      teamId: { in: memberships.teamIds },
    };

    if (projectId) {
      where.projectId = projectId;
    }

    if (status) {
      const normalizedStatus = status.toUpperCase();
      if (!(normalizedStatus in SprayPlanStatus)) {
        return NextResponse.json({ error: 'Invalid status filter' }, { status: 400 });
      }
      where.status = SprayPlanStatus[normalizedStatus as keyof typeof SprayPlanStatus];
    }

    const [plans, total] = await Promise.all([
      prisma.sprayPlan.findMany({
        where,
        select: {
          id: true,
          name: true,
          status: true,
          progress: true,
          errorMessage: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          summary: true,
          project: {
            select: {
              id: true,
              name: true,
              location: true,
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: {
              missions: true,
              zones: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.sprayPlan.count({ where }),
    ]);

    return NextResponse.json({
      plans,
      total,
      limit,
      offset,
    });
  } catch (error) {
    console.error('[spray-plans] list failed', error);
    return NextResponse.json({ error: 'Failed to list spray plans' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthenticatedUser();
    if (!auth.authenticated || !auth.userId) {
      return NextResponse.json({ error: auth.error || 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const projectId = typeof body?.projectId === 'string' ? body.projectId : null;

    if (!projectId) {
      return NextResponse.json({ error: 'projectId is required' }, { status: 400 });
    }

    const access = await checkProjectAccess(projectId);
    if (!access.hasAccess || !access.teamId) {
      return NextResponse.json({ error: access.error || 'Access denied' }, { status: 403 });
    }

    const result = await createSprayPlan({
      projectId,
      teamId: access.teamId,
      userId: auth.userId,
      name: typeof body?.name === 'string' ? body.name : undefined,
      classes: Array.isArray(body?.classes)
        ? body.classes.filter((value: unknown): value is string => typeof value === 'string')
        : undefined,
      includeAIDetections:
        typeof body?.includeAIDetections === 'boolean' ? body.includeAIDetections : undefined,
      includeManualAnnotations:
        typeof body?.includeManualAnnotations === 'boolean' ? body.includeManualAnnotations : undefined,
      includeUnverified: typeof body?.includeUnverified === 'boolean' ? body.includeUnverified : undefined,
      minConfidence: typeof body?.minConfidence === 'number' ? body.minConfidence : undefined,
      zoneRadiusMeters: typeof body?.zoneRadiusMeters === 'number' ? body.zoneRadiusMeters : undefined,
      minDetectionsPerZone:
        typeof body?.minDetectionsPerZone === 'number' ? body.minDetectionsPerZone : undefined,
      maxZonesPerMission:
        typeof body?.maxZonesPerMission === 'number' ? body.maxZonesPerMission : undefined,
      maxAreaHaPerMission:
        typeof body?.maxAreaHaPerMission === 'number' ? body.maxAreaHaPerMission : undefined,
      maxTankLiters: typeof body?.maxTankLiters === 'number' ? body.maxTankLiters : undefined,
      droneCruiseSpeedMps:
        typeof body?.droneCruiseSpeedMps === 'number' ? body.droneCruiseSpeedMps : undefined,
      sprayRateHaPerMin:
        typeof body?.sprayRateHaPerMin === 'number' ? body.sprayRateHaPerMin : undefined,
      defaultDosePerHa: typeof body?.defaultDosePerHa === 'number' ? body.defaultDosePerHa : undefined,
      startLat: typeof body?.startLat === 'number' ? body.startLat : undefined,
      startLon: typeof body?.startLon === 'number' ? body.startLon : undefined,
      returnToStart: typeof body?.returnToStart === 'boolean' ? body.returnToStart : undefined,
      includeCompliance: typeof body?.includeCompliance === 'boolean' ? body.includeCompliance : undefined,
      enableWeatherOptimization:
        typeof body?.enableWeatherOptimization === 'boolean'
          ? body.enableWeatherOptimization
          : undefined,
      weatherLookaheadHours:
        typeof body?.weatherLookaheadHours === 'number' ? body.weatherLookaheadHours : undefined,
      maxWindSpeedMps: typeof body?.maxWindSpeedMps === 'number' ? body.maxWindSpeedMps : undefined,
      maxGustSpeedMps: typeof body?.maxGustSpeedMps === 'number' ? body.maxGustSpeedMps : undefined,
      maxPrecipProbability:
        typeof body?.maxPrecipProbability === 'number' ? body.maxPrecipProbability : undefined,
      minTemperatureC: typeof body?.minTemperatureC === 'number' ? body.minTemperatureC : undefined,
      maxTemperatureC: typeof body?.maxTemperatureC === 'number' ? body.maxTemperatureC : undefined,
      missionTurnaroundMinutes:
        typeof body?.missionTurnaroundMinutes === 'number' ? body.missionTurnaroundMinutes : undefined,
      preferredLaunchTimeUtc:
        typeof body?.preferredLaunchTimeUtc === 'string' ? body.preferredLaunchTimeUtc : undefined,
    });

    return NextResponse.json(
      {
        success: true,
        planId: result.planId,
        message: 'Spray plan queued for generation',
      },
      { status: 202 }
    );
  } catch (error) {
    console.error('[spray-plans] create failed', error);
    const message = error instanceof Error ? error.message : 'Failed to create spray plan';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
