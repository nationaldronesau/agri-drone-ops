import { NextRequest, NextResponse } from 'next/server';
import exifr from 'exifr';
// @ts-ignore
import ExifParser from 'exif-parser';
// @ts-ignore
import fastExif from 'fast-exif';
// @ts-ignore
import nodeExif from 'node-exif';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    const results = {
      filename: file.name,
      fileSize: file.size,
      mimeType: file.type,
      libraries: {}
    };

    // Method 1: exifr with all options
    try {
      console.log('=== EXIFR EXTRACTION ===');
      
      // Try raw parsing first
      const exifrRaw = await exifr.parse(buffer, {
        translateKeys: false,
        translateValues: false,
        reviveValues: false,
        sanitize: false,
        mergeOutput: false,
        silentErrors: false
      });
      
      // Try with all segments
      const exifrFull = await exifr.parse(buffer, {
        gps: true,
        xmp: true,
        exif: true,
        ifd0: true,
        ifd1: true,
        iptc: true,
        icc: true,
        jfif: true,
        ihdr: true,
        tiff: true,
        makerNote: true,
        userComment: true,
        multiSegment: true,
        mergeOutput: false
      });

      results.libraries.exifr = {
        raw: exifrRaw,
        full: exifrFull,
        gps: await exifr.gps(buffer).catch(() => null),
        fieldCounts: Object.entries(exifrFull || {}).reduce((acc, [key, val]) => {
          if (typeof val === 'object' && val !== null) {
            acc[key] = Object.keys(val).length;
          }
          return acc;
        }, {} as any)
      };
    } catch (error) {
      results.libraries.exifr = { error: error.message };
    }

    // Method 2: exif-parser (lower level)
    try {
      console.log('=== EXIF-PARSER EXTRACTION ===');
      const parser = ExifParser.create(buffer);
      const exifResult = parser.parse();
      
      results.libraries.exifParser = {
        result: exifResult,
        tags: exifResult.tags || {},
        gps: exifResult.gps || {},
        imageSize: exifResult.imageSize || {}
      };
    } catch (error) {
      results.libraries.exifParser = { error: error.message };
    }

    // Method 3: fast-exif
    try {
      console.log('=== FAST-EXIF EXTRACTION ===');
      const fastResult = await new Promise((resolve, reject) => {
        fastExif.read(buffer, (error: any, data: any) => {
          if (error) reject(error);
          else resolve(data);
        });
      });
      
      results.libraries.fastExif = {
        result: fastResult
      };
    } catch (error) {
      results.libraries.fastExif = { error: error.message };
    }

    // Method 4: node-exif
    try {
      console.log('=== NODE-EXIF EXTRACTION ===');
      const nodeResult = await new Promise((resolve, reject) => {
        nodeExif(buffer, (error: any, data: any) => {
          if (error) reject(error);
          else resolve(data);
        });
      });
      
      results.libraries.nodeExif = {
        result: nodeResult
      };
    } catch (error) {
      results.libraries.nodeExif = { error: error.message };
    }

    // Search for GPS-like values across all results
    const gpsAnalysis = {
      potentialLatitudes: [],
      potentialLongitudes: [],
      potentialAltitudes: [],
      gimbalFields: [],
      lrfFields: []
    };

    // Recursive function to search for GPS values
    function searchForGPS(obj: any, path = '') {
      if (typeof obj !== 'object' || obj === null) return;
      
      for (const [key, value] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${key}` : key;
        const keyLower = key.toLowerCase();
        
        if (typeof value === 'number') {
          // Potential latitude (-90 to 90)
          if (value >= -90 && value <= 90 && Math.abs(value) > 0.1) {
            if (keyLower.includes('lat') || keyLower.includes('latitude')) {
              gpsAnalysis.potentialLatitudes.push({ path: fullPath, value, key });
            } else if (value >= -90 && value <= 90 && Math.abs(value) > 10) {
              gpsAnalysis.potentialLatitudes.push({ path: fullPath, value, key, note: 'suspicious range' });
            }
          }
          
          // Potential longitude (-180 to 180)  
          if (value >= -180 && value <= 180 && Math.abs(value) > 0.1) {
            if (keyLower.includes('lon') || keyLower.includes('longitude')) {
              gpsAnalysis.potentialLongitudes.push({ path: fullPath, value, key });
            } else if (Math.abs(value) > 90 && Math.abs(value) <= 180) {
              gpsAnalysis.potentialLongitudes.push({ path: fullPath, value, key, note: 'suspicious range' });
            }
          }
          
          // Potential altitude
          if (value > 0 && value < 10000 && keyLower.includes('alt')) {
            gpsAnalysis.potentialAltitudes.push({ path: fullPath, value, key });
          }
          
          // Gimbal fields
          if (keyLower.includes('gimbal')) {
            gpsAnalysis.gimbalFields.push({ path: fullPath, value, key });
          }
          
          // LRF fields
          if (keyLower.includes('lrf') || keyLower.includes('rangefinder')) {
            gpsAnalysis.lrfFields.push({ path: fullPath, value, key });
          }
        } else if (typeof value === 'object') {
          searchForGPS(value, fullPath);
        }
      }
    }

    // Search all library results
    Object.values(results.libraries).forEach(libResult => {
      if (libResult && typeof libResult === 'object' && !libResult.error) {
        searchForGPS(libResult);
      }
    });

    return NextResponse.json({
      ...results,
      gpsAnalysis
    });

  } catch (error) {
    console.error('Multi-EXIF debug error:', error);
    return NextResponse.json({ error: 'Failed to parse with multiple libraries' }, { status: 500 });
  }
}