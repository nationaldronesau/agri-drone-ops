/**
 * Training Datasets API Routes
 * 
 * Location: app/api/training/datasets/route.ts
 * 
 * POST /api/training/datasets - Create dataset from annotations
 * GET /api/training/datasets - List datasets
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { datasetPreparation } from '@/lib/services/dataset-preparation';

// ===========================================
// POST - Create new dataset from annotations
// ===========================================

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const {
      name,
      description,
      projectId,
      sessionIds,        // Optional: specific annotation sessions
      classes,           // Required: ["wattle", "lantana", ...]
      splitRatio,        // Optional: { train: 0.7, val: 0.2, test: 0.1 }
      includeAIDetections = true,
      includeManualAnnotations = true,
      minConfidence = 0.5,
      teamId,            // Required
    } = body;

    // Validation
    if (!name) {
      return NextResponse.json(
        { error: 'name is required' },
        { status: 400 }
      );
    }

    if (!classes || !Array.isArray(classes) || classes.length === 0) {
      return NextResponse.json(
        { error: 'classes array is required and must not be empty' },
        { status: 400 }
      );
    }

    if (!teamId) {
      return NextResponse.json(
        { error: 'teamId is required' },
        { status: 400 }
      );
    }

    // If projectId provided, verify it exists and belongs to team
    if (projectId) {
      const project = await prisma.project.findFirst({
        where: {
          id: projectId,
          teamId: teamId,
        },
      });

      if (!project) {
        return NextResponse.json(
          { error: 'Project not found or access denied' },
          { status: 404 }
        );
      }
    }

    // Prepare the dataset
    const result = await datasetPreparation.prepareDataset(teamId, name, {
      projectId,
      sessionIds,
      classes,
      splitRatio: splitRatio || { train: 0.7, val: 0.2, test: 0.1 },
      includeAIDetections,
      includeManualAnnotations,
      minConfidence,
    });

    // Update with description if provided
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
    
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  }
}

// ===========================================
// GET - List datasets
// ===========================================

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const teamId = searchParams.get('teamId');
    const projectId = searchParams.get('projectId');
    const limit = parseInt(searchParams.get('limit') || '20');
    const offset = parseInt(searchParams.get('offset') || '0');

    if (!teamId) {
      return NextResponse.json(
        { error: 'teamId is required' },
        { status: 400 }
      );
    }

    const where: any = { teamId };
    
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

    // Format response
    const formattedDatasets = datasets.map(dataset => ({
      ...dataset,
      classes: JSON.parse(dataset.classes),
      augmentationConfig: dataset.augmentationConfig 
        ? JSON.parse(dataset.augmentationConfig) 
        : null,
      latestJob: dataset.trainingJobs[0] || null,
    }));

    return NextResponse.json({
      datasets: formattedDatasets,
      total,
      limit,
      offset,
    });

  } catch (error) {
    console.error('Error listing datasets:', error);
    return NextResponse.json(
      { error: 'Failed to list datasets' },
      { status: 500 }
    );
  }
}
