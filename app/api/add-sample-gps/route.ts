import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';

export async function POST(request: NextRequest) {
  try {
    // Get assets without GPS
    const assetsWithoutGPS = await prisma.asset.findMany({
      where: {
        projectId: 'default-project',
        OR: [
          { gpsLatitude: null },
          { gpsLongitude: null }
        ]
      }
    });

    // Sample GPS coordinates for different farm locations around Brisbane, Australia
    const sampleLocations = [
      { lat: -27.4698, lon: 153.0251, alt: 120, description: 'Brisbane Farm Block A' },
      { lat: -27.4712, lon: 153.0267, alt: 125, description: 'Brisbane Farm Block B' },
      { lat: -27.4685, lon: 153.0234, alt: 118, description: 'Brisbane Farm Block C' },
      { lat: -27.4701, lon: 153.0289, alt: 130, description: 'Brisbane Farm Block D' },
      { lat: -27.4673, lon: 153.0201, alt: 115, description: 'Brisbane Farm Block E' },
    ];

    const updates = [];
    
    for (let i = 0; i < assetsWithoutGPS.length; i++) {
      const asset = assetsWithoutGPS[i];
      const location = sampleLocations[i % sampleLocations.length];
      
      // Add some random variation to make it more realistic
      const randomLat = location.lat + (Math.random() - 0.5) * 0.001; // ~100m variation
      const randomLon = location.lon + (Math.random() - 0.5) * 0.001;
      const randomAlt = location.alt + Math.floor((Math.random() - 0.5) * 20); // ±10m variation
      
      const update = prisma.asset.update({
        where: { id: asset.id },
        data: {
          gpsLatitude: randomLat,
          gpsLongitude: randomLon,
          altitude: randomAlt,
          gimbalPitch: -45 + Math.floor((Math.random() - 0.5) * 30), // -60° to -30°
          gimbalRoll: Math.floor((Math.random() - 0.5) * 10), // ±5°
          gimbalYaw: Math.floor(Math.random() * 360), // 0° to 360°
        }
      });
      
      updates.push(update);
    }

    const results = await Promise.all(updates);

    return NextResponse.json({
      message: `Added sample GPS data to ${results.length} images`,
      updatedAssets: results.length
    });
  } catch (error) {
    console.error('Failed to add sample GPS:', error);
    return NextResponse.json(
      { error: 'Failed to add sample GPS data' },
      { status: 500 }
    );
  }
}