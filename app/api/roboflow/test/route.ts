import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
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
    const projectsUrl = `https://api.roboflow.com/${workspace}/projects?api_key=${apiKey}`;
    console.log('Fetching projects from:', projectsUrl);
    
    const projectsResponse = await fetch(projectsUrl);
    const projectsData = await projectsResponse.json();
    
    if (!projectsResponse.ok) {
      return NextResponse.json({
        error: 'Failed to fetch projects',
        status: projectsResponse.status,
        data: projectsData
      }, { status: 500 });
    }
    
    console.log('Projects found:', projectsData);
    
    // Test 2: Get details for each project
    const projectDetails = [];
    
    if (projectsData.projects && Array.isArray(projectsData.projects)) {
      for (const project of projectsData.projects) {
        try {
          const detailUrl = `https://api.roboflow.com/${workspace}/${project.id}?api_key=${apiKey}`;
          const detailResponse = await fetch(detailUrl);
          const detailData = await detailResponse.json();
          
          projectDetails.push({
            id: project.id,
            name: project.name,
            details: detailData
          });
        } catch (error) {
          console.error(`Failed to get details for project ${project.id}:`, error instanceof Error ? error.message : 'Unknown');
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
    console.error('Training API test failed:', error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json({
      error: 'API test failed. Please check your configuration.'
    }, { status: 500 });
  }
}