import { NextResponse } from 'next/server';
import { roboflowService } from '@/lib/services/roboflow';
import { blockInProduction } from '@/lib/utils/dev-only';

export async function POST() {
  const prodBlock = blockInProduction();
  if (prodBlock) return prodBlock;

  try {
    const apiKey = process.env.ROBOFLOW_API_KEY;
    
    if (!apiKey) {
      return NextResponse.json({
        error: 'Missing Roboflow API key'
      }, { status: 400 });
    }
    
    // Generate a simple test image as base64
    const testImageBase64 = generateSimpleTestImage();
    
    console.log('Testing SAHI endpoint with Lantana model...');
    
    // Test detection using our service
    const detections = await roboflowService.detectWeeds(testImageBase64, 'LANTANA_SAHI');
    
    return NextResponse.json({
      success: true,
      endpoint: 'SAHI Workflow',
      detections: detections.length,
      data: detections,
      message: detections.length > 0 
        ? `Found ${detections.length} detections!` 
        : 'No detections found (expected with test image)'
    });
    
  } catch (error) {
    console.error('SAHI test failed:', error);
    return NextResponse.json({
      error: 'SAHI detection test failed. Please check your configuration.'
    }, { status: 500 });
  }
}

function generateSimpleTestImage(): string {
  // A minimal 1x1 green pixel JPEG as base64
  // This won't detect anything but will test the API connection
  return '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/2wBDAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQH/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD+/iiiigD//9k=';
}
