import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    const workspace = process.env.ROBOFLOW_WORKSPACE;
    
    if (!apiKey || !workspace) {
      return NextResponse.json({
        error: 'Missing Roboflow credentials'
      }, { status: 400 });
    }
    
    // Test with a simple test image (you can replace this with actual image data)
    const testImageBase64 = await generateTestImage();
    
    // Test the Lantana/Wattle model
    const projectId = 'lantana-classification';
    const version = 5;
    const url = `https://detect.roboflow.com/${workspace}/${projectId}/${version}`;
    
    console.log('Testing detection with URL:', url);
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        image: testImageBase64,
        confidence: 0.4,
        overlap: 0.3,
      }),
    });
    
    const responseText = await response.text();
    console.log('Raw response:', responseText);
    
    if (!response.ok) {
      return NextResponse.json({
        error: 'Roboflow detection failed',
        status: response.status,
        statusText: response.statusText,
        response: responseText
      }, { status: 500 });
    }
    
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      return NextResponse.json({
        error: 'Failed to parse response',
        response: responseText
      }, { status: 500 });
    }
    
    return NextResponse.json({
      success: true,
      model: `${workspace}/${projectId}/${version}`,
      detections: data.predictions?.length || 0,
      data: data
    });
    
  } catch (error) {
    console.error('Detection test failed:', error);
    return NextResponse.json({
      error: 'Detection test failed. Please check your configuration.'
    }, { status: 500 });
  }
}

async function generateTestImage(): Promise<string> {
  // Use a minimal valid JPEG as base64 for testing
  // This is a 1x1 pixel green JPEG image
  return '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAA8ADwDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD+/iiiigD//9k=';
}