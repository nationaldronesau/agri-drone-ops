import { NextRequest, NextResponse } from 'next/server';
import { blockInProduction } from '@/lib/utils/dev-only';

/**
 * SECURITY: Helper to fetch from Roboflow without exposing API key in logs
 */
async function fetchRoboflowTest(baseUrl: string, apiKey: string): Promise<Response> {
  const urlWithKey = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}api_key=${apiKey}`;
  return fetch(urlWithKey);
}

export async function GET(request: NextRequest) {
  const prodBlock = blockInProduction();
  if (prodBlock) return prodBlock;

  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const workspace = process.env.ROBOFLOW_WORKSPACE;

    if (!apiKey || !workspace) {
      return NextResponse.json({
        error: 'Missing Roboflow credentials',
        apiKey: !!apiKey,
        workspace: !!workspace
      }, { status: 400 });
    }

    console.log('Testing Roboflow API with workspace:', workspace);

    // Test 1: List projects in workspace
    // SECURITY: API key is added by helper function, not logged
    const projectsResponse = await fetchRoboflowTest(
      `https://api.roboflow.com/${workspace}/projects`,
      apiKey
    );
    const projectsData = await projectsResponse.json();

    if (!projectsResponse.ok) {
      return NextResponse.json({
        error: 'Failed to fetch projects',
        status: projectsResponse.status,
        // SECURITY: Don't include raw error data that might expose config
        message: 'Check Roboflow credentials and workspace configuration'
      }, { status: 500 });
    }

    console.log('Projects found:', projectsData.projects?.length || 0);

    // Test 2: Get details for each project
    const projectDetails = [];

    if (projectsData.projects && Array.isArray(projectsData.projects)) {
      for (const project of projectsData.projects) {
        try {
          // SECURITY: API key is added by helper function
          const detailResponse = await fetchRoboflowTest(
            `https://api.roboflow.com/${workspace}/${project.id}`,
            apiKey
          );
          const detailData = await detailResponse.json();
          
          projectDetails.push({
            id: project.id,
            name: project.name,
            details: detailData
          });
        } catch (error) {
          console.error(`Failed to get details for project ${project.id}:`, error);
          projectDetails.push({
            id: project.id,
            name: project.name,
            error: 'Failed to fetch project details'
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      workspace: workspace,
      projects: projectsData,
      projectDetails: projectDetails,
      apiKeyStatus: 'Connected successfully'
    });

  } catch (error) {
    console.error('Training API test failed:', error);
    return NextResponse.json({
      error: 'API test failed. Please check your configuration.'
    }, { status: 500 });
  }
}
