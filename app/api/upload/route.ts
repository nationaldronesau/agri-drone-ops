import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import exifr from 'exifr';
import prisma from '@/lib/db';
import { roboflowService, ROBOFLOW_MODELS, ModelType } from '@/lib/services/roboflow';
import { pixelToGeo } from '@/lib/utils/georeferencing';
import { S3Service } from '@/lib/services/s3';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const files = formData.getAll('files') as File[];
    const projectId = formData.get('projectId') as string || 'default-project';
    const runDetection = formData.get('runDetection') === 'true';
    const detectionModels = formData.get('detectionModels') as string || '';
    
    if (!files || files.length === 0) {
      return NextResponse.json(
        { error: 'No files provided' },
        { status: 400 }
      );
    }

    const uploadResults = [];

    for (const file of files) {
      try {
        console.log(`Processing file: ${file.name}`);
        
        // Validate file type
        if (!file.type.startsWith('image/')) {
          uploadResults.push({
            name: file.name,
            error: 'Invalid file type. Only images are allowed.'
          });
          continue;
        }

      // Generate unique filename
      const fileExtension = path.extname(file.name);
      const uniqueFilename = `${randomUUID()}${fileExtension}`;
      
      // Convert file to buffer
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      // Extract EXIF and XMP metadata using the two-pronged approach
      const extractedData = {
        gpsLatitude: null,
        gpsLongitude: null,
        altitude: null,
        gimbalPitch: null,
        gimbalRoll: null,
        gimbalYaw: null,
        lrfDistance: null,
        lrfTargetLat: null,
        lrfTargetLon: null,
        imageWidth: null,
        imageHeight: null
      };
      
      let fullMetadata = null;
      
      try {
        // STEP 1: Structured parsing - Target known EXIF/GPS fields
        console.log('=== STEP 1: Structured EXIF/GPS Parsing ===');
        
        // Parse GPS from EXIF GPS IFD
        const gpsData = await exifr.gps(buffer);
        console.log('GPS EXIF data:', gpsData);
        
        if (gpsData) {
          extractedData.gpsLatitude = gpsData.latitude;
          extractedData.gpsLongitude = gpsData.longitude;
          extractedData.altitude = gpsData.altitude;
        }
        
        // Parse standard EXIF
        const exifData = await exifr.parse(buffer, {
          exif: true,
          pick: ['FocalLength', 'DateTimeOriginal', 'ISO', 'ExposureTime', 'FNumber', 'ExifImageWidth', 'ExifImageHeight']
        });
        console.log('EXIF data:', exifData);
        
        if (exifData) {
          extractedData.imageWidth = exifData.ExifImageWidth;
          extractedData.imageHeight = exifData.ExifImageHeight;
        }
        
        // STEP 2: Blanket XMP search - Parse all XMP data
        console.log('=== STEP 2: Blanket XMP Search ===');
        
        const xmpData = await exifr.parse(buffer, {
          xmp: true,
          mergeOutput: false
        });
        console.log('XMP structure:', xmpData);
        
        
        // Also check XMP data structure if available
        if (xmpData && xmpData.xmp) {
          const droneFields = xmpData.xmp;
          console.log('XMP drone-dji fields:', droneFields);
          
          // Blanket search for patterns in case field names vary
          for (const [key, value] of Object.entries(droneFields)) {
            const keyLower = key.toLowerCase();
            
            // Search for latitude patterns
            if (keyLower.includes('lat') && typeof value === 'number' && !extractedData.gpsLatitude) {
              extractedData.gpsLatitude = value;
              console.log(`Found latitude in XMP field: ${key} = ${value}`);
            }
            
            // Search for longitude patterns  
            if (keyLower.includes('lon') && typeof value === 'number' && !extractedData.gpsLongitude) {
              extractedData.gpsLongitude = value;
              console.log(`Found longitude in XMP field: ${key} = ${value}`);
            }
            
            // Search for gimbal pitch patterns
            if (keyLower.includes('gimbal') && keyLower.includes('pitch') && typeof value === 'number') {
              extractedData.gimbalPitch = value;
              console.log(`Found gimbal pitch in XMP field: ${key} = ${value}`);
            }
            
            // Search for altitude patterns
            if (keyLower.includes('altitude') && typeof value === 'number' && !extractedData.altitude) {
              extractedData.altitude = value;
              console.log(`Found altitude in XMP field: ${key} = ${value}`);
            }
            
            // Search for LRF patterns
            if (keyLower.includes('lrf') && typeof value === 'number') {
              if (keyLower.includes('distance')) extractedData.lrfDistance = value;
              if (keyLower.includes('lat')) extractedData.lrfTargetLat = value;
              if (keyLower.includes('lon')) extractedData.lrfTargetLon = value;
              console.log(`Found LRF data in XMP field: ${key} = ${value}`);
            }
          }
        }
        
        // Get full metadata for storage
        fullMetadata = await exifr.parse(buffer, {
          gps: true,
          xmp: true,
          exif: true,
          mergeOutput: true
        });
        
        // Extract from merged metadata (since mergeOutput: true gives us direct access)
        if (fullMetadata) {
          console.log('=== STEP 3: DJI Metadata Extraction ===');
          console.log('Checking merged metadata for DJI fields...');
          
          // Extract altitude (prefer absolute altitude)
          extractedData.altitude = extractedData.altitude || 
            fullMetadata['AbsoluteAltitude'] || 
            fullMetadata['RelativeAltitude'] ||
            fullMetadata['drone-dji:AbsoluteAltitude'] || 
            fullMetadata['drone-dji:RelativeAltitude'];
            
          // Extract gimbal orientation
          extractedData.gimbalPitch = fullMetadata['GimbalPitchDegree'] || 
            fullMetadata['drone-dji:GimbalPitchDegree'];
          extractedData.gimbalRoll = fullMetadata['GimbalRollDegree'] || 
            fullMetadata['drone-dji:GimbalRollDegree'];
          extractedData.gimbalYaw = fullMetadata['GimbalYawDegree'] || 
            fullMetadata['drone-dji:GimbalYawDegree'];
            
          // Extract LRF data
          extractedData.lrfDistance = fullMetadata['LRFTargetDistance'] || 
            fullMetadata['drone-dji:LRFTargetDistance'];
          extractedData.lrfTargetLat = fullMetadata['LRFTargetLat'] || 
            fullMetadata['drone-dji:LRFTargetLat'];
          extractedData.lrfTargetLon = fullMetadata['LRFTargetLon'] || 
            fullMetadata['drone-dji:LRFTargetLon'];
          
          console.log('Extracted DJI-specific data:');
          console.log('- Altitude:', extractedData.altitude);
          console.log('- Gimbal Pitch:', extractedData.gimbalPitch);
          console.log('- Gimbal Roll:', extractedData.gimbalRoll);
          console.log('- Gimbal Yaw:', extractedData.gimbalYaw);
          console.log('- LRF Distance:', extractedData.lrfDistance);
        }
        
        console.log('=== EXTRACTION RESULTS ===');
        console.log('Final extracted data:', extractedData);
        
      } catch (error) {
        console.error('Error parsing EXIF/XMP:', error);
        console.error('EXIF Error details:', {
          message: error.message,
          fileName: file.name,
          fileSize: file.size
        });
      }

      // Determine storage type based on environment
      const useS3 = process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID;
      let storageUrl: string;
      let s3Key: string | undefined;
      let s3Bucket: string | undefined;
      let storageType: string = 'local';

      if (useS3) {
        // Upload to S3
        try {
          const s3Result = await S3Service.uploadFile(buffer, {
            projectId: projectId,
            flightSession: formData.get('flightSession') as string || 'default',
            filename: uniqueFilename,
            contentType: file.type,
            metadata: {
              originalName: file.name,
              uploadedBy: 'default-user', // TODO: Get from session
            }
          });

          s3Key = s3Result.key;
          s3Bucket = s3Result.bucket;
          storageUrl = s3Result.location;
          storageType = 's3';
        } catch (s3Error) {
          console.error('S3 upload failed, falling back to local storage:', s3Error);
          // Fall back to local storage
          const uploadDir = path.join(process.cwd(), 'public', 'uploads');
          await mkdir(uploadDir, { recursive: true });
          
          const filePath = path.join(uploadDir, uniqueFilename);
          await writeFile(filePath, buffer);
          storageUrl = `/uploads/${uniqueFilename}`;
        }
      } else {
        // Save file to local storage
        const uploadDir = path.join(process.cwd(), 'public', 'uploads');
        await mkdir(uploadDir, { recursive: true });
        
        const filePath = path.join(uploadDir, uniqueFilename);
        await writeFile(filePath, buffer);
        storageUrl = `/uploads/${uniqueFilename}`;
      }

      // Create database record
      const asset = await prisma.asset.create({
        data: {
          fileName: file.name,
          storageUrl: storageUrl,
          mimeType: file.type,
          fileSize: file.size,
          
          // S3 fields
          s3Key: s3Key,
          s3Bucket: s3Bucket,
          storageType: storageType,
          
          // Use extracted data from two-pronged approach
          gpsLatitude: extractedData.gpsLatitude,
          gpsLongitude: extractedData.gpsLongitude,
          altitude: extractedData.altitude,
          gimbalPitch: extractedData.gimbalPitch,
          gimbalRoll: extractedData.gimbalRoll,
          gimbalYaw: extractedData.gimbalYaw,
          lrfDistance: extractedData.lrfDistance,
          lrfTargetLat: extractedData.lrfTargetLat,
          lrfTargetLon: extractedData.lrfTargetLon,
          imageWidth: extractedData.imageWidth,
          imageHeight: extractedData.imageHeight,
          
          // Store full metadata for reference
          metadata: fullMetadata,
          // Use projectId from form data
          projectId: projectId,
          createdById: "default-user", // TODO: Get from session
          
          // Flight session
          flightSession: formData.get('flightSession') as string || null,
        },
      });

      // Run AI detection if requested
      let detections = [];
      if (runDetection && extractedData.gpsLatitude && extractedData.gpsLongitude) {
        try {
          console.log('Running Roboflow detection...');
          
          // Parse selected models
          const selectedModels = detectionModels 
            ? detectionModels.split(',').filter(m => m in ROBOFLOW_MODELS) as ModelType[]
            : Object.keys(ROBOFLOW_MODELS) as ModelType[];
          
          // Convert buffer to base64
          const imageBase64 = buffer.toString('base64');
          
          // Run detection on selected models
          const detectionResults = await roboflowService.detectMultipleModels(
            imageBase64,
            selectedModels
          );
          
          // Convert pixel coordinates to geographic coordinates
          if (detectionResults.length > 0 && extractedData.imageWidth && extractedData.imageHeight) {
            // Create a processing job
            const job = await prisma.processingJob.create({
              data: {
                projectId: projectId,
                type: 'AI_DETECTION',
                status: 'COMPLETED',
                config: { models: selectedModels },
                completedAt: new Date(),
              },
            });
            
            // Save detections with georeferenced coordinates
            for (const detection of detectionResults) {
              // Convert pixel coordinates to geographic coordinates
              const geoCoords = pixelToGeo(
                detection.x,
                detection.y,
                extractedData.imageWidth,
                extractedData.imageHeight,
                extractedData.gpsLatitude,
                extractedData.gpsLongitude,
                extractedData.altitude || 100,
                extractedData.gimbalPitch || 0,
                extractedData.gimbalRoll || 0,
                extractedData.gimbalYaw || 0
              );
              
              const savedDetection = await prisma.detection.create({
                data: {
                  jobId: job.id,
                  assetId: asset.id,
                  type: 'AI',
                  className: detection.class,
                  confidence: detection.confidence,
                  boundingBox: {
                    x: detection.x,
                    y: detection.y,
                    width: detection.width,
                    height: detection.height,
                  },
                  geoCoordinates: {
                    type: 'Point',
                    coordinates: [geoCoords.longitude, geoCoords.latitude],
                  },
                  centerLat: geoCoords.latitude,
                  centerLon: geoCoords.longitude,
                  metadata: {
                    modelType: detection.modelType,
                    color: detection.color,
                  },
                },
              });
              
              detections.push({
                ...detection,
                geoCoordinates: geoCoords,
                id: savedDetection.id,
              });
            }
          }
          
          console.log(`Detection complete: ${detections.length} objects found`);
        } catch (detectionError) {
          console.error('Detection failed:', detectionError);
          // Don't fail the upload if detection fails
        }
      }

        uploadResults.push({
          id: asset.id,
          name: file.name,
          path: asset.storageUrl,
          size: file.size,
          metadata: fullMetadata,
          gpsLatitude: extractedData.gpsLatitude,
          gpsLongitude: extractedData.gpsLongitude,
          altitude: extractedData.altitude,
          detections: detections,
          success: true,
          warning: (!extractedData.gpsLatitude || !extractedData.gpsLongitude) ? 'No GPS data found in image' : null
        });
        
      } catch (fileError) {
        console.error(`Error processing file ${file.name}:`, fileError);
        uploadResults.push({
          name: file.name,
          error: `Processing failed: ${fileError.message}`,
          success: false
        });
      }
    }

    return NextResponse.json({
      message: `Successfully uploaded ${uploadResults.filter(r => r.success).length} files`,
      files: uploadResults
    });

  } catch (error) {
    console.error('Upload error:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      name: error.name
    });
    return NextResponse.json(
      { 
        error: 'Failed to upload files',
        details: error.message,
        type: error.name
      },
      { status: 500 }
    );
  }
}

// Configure maximum file size (50MB)
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb',
    },
  },
};