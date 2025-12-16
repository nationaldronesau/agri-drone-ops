import { NextRequest, NextResponse } from 'next/server';
import exifr from 'exifr';
import { blockInProduction } from '@/lib/utils/dev-only';

export async function POST(request: NextRequest) {
  const prodBlock = blockInProduction();
  if (prodBlock) return prodBlock;

  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Parse ALL metadata with comprehensive options
    const allMetadata = await exifr.parse(buffer, {
      pick: null, // Get everything
      mergeOutput: false,
      silentErrors: false
    });
    
    // Try different XMP parsing approaches
    let xmpRaw = null;
    try {
      xmpRaw = await exifr.parse(buffer, {
        xmp: true,
        translateKeys: false,
        translateValues: false,
        reviveValues: false,
        mergeOutput: false
      });
    } catch (e) {
      console.log('XMP raw parsing failed');
    }
    
    // Parse GPS specific with all possible options
    const gpsData = await exifr.gps(buffer);
    
    // Parse with all segments enabled
    const fullMetadata = await exifr.parse(buffer, {
      gps: true,
      xmp: true,
      ifd0: true,
      ifd1: true,
      exif: true,
      iptc: true,
      jfif: true,
      ihdr: true,
      tiff: true,
      icc: true,
      // Enable ALL segments
      makerNote: true,
      userComment: true,
      multiSegment: true,
      chunked: false,
      firstChunkSize: undefined,
      firstChunkSizeNode: undefined,
      mergeOutput: false
    });
    
    // Try to get raw EXIF data
    let rawExif = null;
    try {
      rawExif = await exifr.parse(buffer, {
        pick: null,
        translateKeys: false,
        translateValues: false,
        reviveValues: false,
        sanitize: false,
        mergeOutput: false
      });
    } catch (e) {
      console.log('Failed to get raw EXIF');
    }
    
    // Try XMP separately
    let xmpData = null;
    try {
      xmpData = await exifr.parse(buffer, {
        xmp: true,
        mergeOutput: false,
        translateKeys: false
      });
    } catch (e) {
      console.log('No XMP data found');
    }
    
    // Try to get maker notes (DJI specific data)
    let makerNotes = null;
    try {
      makerNotes = await exifr.parse(buffer, {
        makerNote: true,
        mergeOutput: false
      });
    } catch (e) {
      console.log('No maker notes found');
    }

    return NextResponse.json({
      filename: file.name,
      allFields: Object.keys(allMetadata || {}),
      allMetadata: allMetadata,
      gpsData: gpsData,
      fullMetadata: fullMetadata,
      rawExif: rawExif,
      xmpData: xmpData,
      xmpRaw: xmpRaw,
      makerNotes: makerNotes,
      fullFields: Object.keys(fullMetadata || {}),
      
      // Detailed field analysis
      segmentAnalysis: Object.entries(fullMetadata || {}).reduce((acc, [segment, data]) => {
        if (typeof data === 'object' && data !== null) {
          acc[segment] = {
            fieldCount: Object.keys(data).length,
            fields: Object.keys(data),
            gpsFields: Object.keys(data).filter(k => 
              k.toLowerCase().includes('gps') || 
              k.toLowerCase().includes('latitude') || 
              k.toLowerCase().includes('longitude')
            ),
            droneFields: Object.keys(data).filter(k => 
              k.toLowerCase().includes('gimbal') || 
              k.toLowerCase().includes('flight') || 
              k.toLowerCase().includes('altitude') ||
              k.toLowerCase().includes('lrf') ||
              k.toLowerCase().includes('rangefinder')
            )
          };
        }
        return acc;
      }, {} as any),
      
      // Look for GPS in different locations
      gpsInIfd0: fullMetadata?.ifd0 ? Object.keys(fullMetadata.ifd0).filter(k => k.toLowerCase().includes('gps')) : [],
      gpsInExif: fullMetadata?.exif ? Object.keys(fullMetadata.exif).filter(k => k.toLowerCase().includes('gps')) : [],
      gpsInXmp: xmpData?.xmp ? Object.keys(xmpData.xmp).filter(k => k.toLowerCase().includes('gps') || k.toLowerCase().includes('latitude') || k.toLowerCase().includes('longitude')) : [],
      
      // Search for potential coordinate values (numbers between -180 and 180)
      potentialCoordinates: Object.entries(fullMetadata || {}).reduce((acc, [segment, data]) => {
        if (typeof data === 'object' && data !== null) {
          const coords = Object.entries(data).filter(([key, value]) => 
            typeof value === 'number' && 
            value >= -180 && value <= 180 && 
            Math.abs(value) > 1 // Exclude small numbers like 0, 1, etc.
          );
          if (coords.length > 0) {
            acc[segment] = coords;
          }
        }
        return acc;
      }, {} as any)
    });
  } catch (error) {
    console.error('Debug EXIF error:', error);
    return NextResponse.json({ error: 'Failed to parse EXIF' }, { status: 500 });
  }
}