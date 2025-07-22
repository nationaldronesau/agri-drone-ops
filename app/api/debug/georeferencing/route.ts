import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { precisionPixelToGeo, extractPrecisionParams, debugGeoreferencing } from '@/lib/utils/precision-georeferencing';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const assetId = searchParams.get('assetId');
    const pixelX = parseFloat(searchParams.get('x') || '2640'); // Default to center
    const pixelY = parseFloat(searchParams.get('y') || '1978'); // Default to center
    
    if (!assetId) {
      return NextResponse.json({ error: 'assetId parameter required' }, { status: 400 });
    }
    
    // Fetch asset with full metadata
    const asset = await prisma.asset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        fileName: true,
        gpsLatitude: true,
        gpsLongitude: true,
        altitude: true,
        imageWidth: true,
        imageHeight: true,
        gimbalPitch: true,
        gimbalRoll: true,
        gimbalYaw: true,
        metadata: true,
        project: {
          select: {
            name: true,
            location: true,
          }
        }
      }
    });
    
    if (!asset || !asset.metadata) {
      return NextResponse.json({ error: 'Asset not found or missing metadata' }, { status: 404 });
    }
    
    // Extract precision parameters
    const precisionParams = extractPrecisionParams(asset.metadata);
    
    // Test pixel coordinate
    const testPixel = { x: pixelX, y: pixelY };
    
    // Old method calculation (simplified)
    const oldResult = {
      latitude: asset.gpsLatitude,
      longitude: asset.gpsLongitude
    };
    
    // New precision method
    const newResult = await precisionPixelToGeo(testPixel, precisionParams);
    
    // LRF reference point (if available)
    const lrfReference = asset.metadata.LRFTargetLat && asset.metadata.LRFTargetLon ? {
      latitude: asset.metadata.LRFTargetLat,
      longitude: asset.metadata.LRFTargetLon,
      altitude: asset.metadata.LRFTargetAlt,
      distance: asset.metadata.LRFTargetDistance
    } : null;
    
    // Calculate accuracy improvements
    const droneToLrf = lrfReference ? calculateDistance(
      asset.gpsLatitude || 0, 
      asset.gpsLongitude || 0,
      lrfReference.latitude,
      lrfReference.longitude
    ) : null;
    
    const oldToLrf = lrfReference ? calculateDistance(
      oldResult.latitude || 0,
      oldResult.longitude || 0,
      lrfReference.latitude,
      lrfReference.longitude
    ) : null;
    
    const newToLrf = lrfReference ? calculateDistance(
      newResult.latitude,
      newResult.longitude,
      lrfReference.latitude,
      lrfReference.longitude
    ) : null;
    
    return NextResponse.json({
      asset: {
        id: asset.id,
        fileName: asset.fileName,
        project: asset.project.name
      },
      testPixel,
      calibratedParameters: {
        focalLength: precisionParams.calibratedFocalLength,
        opticalCenter: {
          x: precisionParams.opticalCenterX,
          y: precisionParams.opticalCenterY
        },
        imageSize: {
          width: precisionParams.imageWidth,
          height: precisionParams.imageHeight
        },
        gimbal: {
          pitch: precisionParams.gimbalPitch,
          roll: precisionParams.gimbalRoll,
          yaw: precisionParams.gimbalYaw
        }
      },
      results: {
        dronePosition: {
          latitude: asset.gpsLatitude,
          longitude: asset.gpsLongitude,
          altitude: asset.altitude
        },
        oldMethod: oldResult,
        newPrecisionMethod: newResult,
        lrfGroundReference: lrfReference
      },
      accuracyAnalysis: {
        droneToLrfDistance: droneToLrf,
        oldMethodErrorFromLrf: oldToLrf,
        newMethodErrorFromLrf: newToLrf,
        improvementFactor: oldToLrf && newToLrf ? (oldToLrf / newToLrf).toFixed(2) + 'x' : null
      },
      debugging: {
        hasLrfData: !!lrfReference,
        hasCalibratedParams: !!(asset.metadata.CalibratedFocalLength),
        usedLrfForCalculation: !!lrfReference,
        metadataKeys: Object.keys(asset.metadata).filter(key => 
          key.includes('LRF') || 
          key.includes('Calibrated') || 
          key.includes('Optical') ||
          key.includes('Dewarp')
        )
      }
    });
    
  } catch (error) {
    console.error('Debug georeferencing error:', error);
    return NextResponse.json(
      { error: 'Failed to debug georeferencing', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// Calculate distance between two lat/lon points in meters
function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth's radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}