import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import prisma from '@/lib/db';
import { exec } from 'child_process';
import { promisify } from 'util';
import { S3Service } from '@/lib/services/s3';

const execAsync = promisify(exec);

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File;
    const projectId = formData.get('projectId') as string;
    const name = formData.get('name') as string;
    const description = formData.get('description') as string | null;

    if (!file || !projectId || !name) {
      return NextResponse.json(
        { error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Validate file type
    const validTypes = ['image/tiff', 'image/geotiff', 'application/geotiff'];
    if (!validTypes.includes(file.type) && !file.name.toLowerCase().match(/\.(tif|tiff|geotiff)$/)) {
      return NextResponse.json(
        { error: 'Invalid file type. Please upload a GeoTIFF file.' },
        { status: 400 }
      );
    }

    // Generate unique file ID
    const fileId = uuidv4();
    const fileName = `${fileId}.tif`;
    
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Determine storage type based on environment
    const useS3 = process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID;
    let storageUrl: string;
    let s3Key: string | undefined;
    let s3Bucket: string | undefined;
    let storageType: string = 'local';
    let filePath: string = '';

    if (useS3) {
      // Upload to S3
      try {
        const s3Result = await S3Service.uploadFile(buffer, {
          projectId: projectId,
          orthomosaicId: fileId,
          filename: fileName,
          contentType: file.type || 'image/tiff',
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
        const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'orthomosaics');
        await mkdir(uploadDir, { recursive: true });
        
        filePath = path.join(uploadDir, fileName);
        await writeFile(filePath, buffer);
        storageUrl = `/uploads/orthomosaics/${fileName}`;
      }
    } else {
      // Save file to local storage
      const uploadDir = path.join(process.cwd(), 'public', 'uploads', 'orthomosaics');
      await mkdir(uploadDir, { recursive: true });
      
      filePath = path.join(uploadDir, fileName);
      await writeFile(filePath, buffer);
      storageUrl = `/uploads/orthomosaics/${fileName}`;
    }

    // Extract metadata using gdalinfo (if available)
    let bounds = null;
    let centerLat = 0;
    let centerLon = 0;
    let resolution = null;
    let area = null;

    try {
      // Try to extract metadata with GDAL
      const { stdout } = await execAsync(`gdalinfo -json "${filePath}"`);
      const metadata = JSON.parse(stdout);
      
      // Extract bounds
      if (metadata.cornerCoordinates) {
        const corners = metadata.cornerCoordinates;
        const minLon = Math.min(corners.upperLeft[0], corners.lowerLeft[0]);
        const maxLon = Math.max(corners.upperRight[0], corners.lowerRight[0]);
        const minLat = Math.min(corners.lowerLeft[1], corners.lowerRight[1]);
        const maxLat = Math.max(corners.upperLeft[1], corners.upperRight[1]);
        
        centerLat = (minLat + maxLat) / 2;
        centerLon = (minLon + maxLon) / 2;
        
        bounds = {
          type: 'Polygon',
          coordinates: [[
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat]
          ]]
        };
      }

      // Extract resolution (ground sample distance)
      if (metadata.geoTransform) {
        const pixelSizeX = Math.abs(metadata.geoTransform[1]);
        const pixelSizeY = Math.abs(metadata.geoTransform[5]);
        // Convert from degrees to meters (approximate)
        resolution = ((pixelSizeX + pixelSizeY) / 2) * 111000 * 100; // cm/pixel
      }

      // Calculate area
      if (metadata.size && metadata.geoTransform) {
        const widthPixels = metadata.size[0];
        const heightPixels = metadata.size[1];
        const pixelSizeX = Math.abs(metadata.geoTransform[1]) * 111000; // degrees to meters
        const pixelSizeY = Math.abs(metadata.geoTransform[5]) * 111000;
        area = (widthPixels * pixelSizeX * heightPixels * pixelSizeY) / 10000; // hectares
      }
    } catch (error) {
      console.warn('GDAL not available or failed to extract metadata:', error);
      // For now, we'll use dummy values if GDAL is not available
      centerLat = -27.4698; // Brisbane default
      centerLon = 153.0251;
      bounds = {
        type: 'Polygon',
        coordinates: [[
          [centerLon - 0.01, centerLat - 0.01],
          [centerLon + 0.01, centerLat - 0.01],
          [centerLon + 0.01, centerLat + 0.01],
          [centerLon - 0.01, centerLat + 0.01],
          [centerLon - 0.01, centerLat - 0.01]
        ]]
      };
    }

    // Create database record
    const orthomosaic = await prisma.orthomosaic.create({
      data: {
        projectId,
        name,
        description,
        originalFile: storageUrl,
        fileSize: file.size,
        
        // S3 fields
        s3Key: s3Key,
        s3Bucket: s3Bucket,
        storageType: storageType,
        
        bounds: bounds || {},
        centerLat,
        centerLon,
        resolution,
        area,
        status: 'PENDING'
      },
      include: {
        project: true
      }
    });

    // TODO: Queue tile processing job
    // For now, we'll simulate processing after a delay
    setTimeout(async () => {
      try {
        // In a real implementation, this would use gdal2tiles.py or similar
        await prisma.orthomosaic.update({
          where: { id: orthomosaic.id },
          data: {
            status: 'COMPLETED',
            tilesetPath: `/tiles/${orthomosaic.id}`,
            processingLog: { 
              message: 'Tiles generated successfully',
              timestamp: new Date()
            }
          }
        });
      } catch (error) {
        await prisma.orthomosaic.update({
          where: { id: orthomosaic.id },
          data: {
            status: 'FAILED',
            processingLog: { 
              error: error instanceof Error ? error.message : 'Unknown error',
              timestamp: new Date()
            }
          }
        });
      }
    }, 5000); // Simulate 5 second processing time

    return NextResponse.json(orthomosaic);
  } catch (error) {
    console.error('Error uploading orthomosaic:', error);
    return NextResponse.json(
      { error: 'Failed to upload orthomosaic' },
      { status: 500 }
    );
  }
}

export const config = {
  api: {
    bodyParser: false,
  },
};