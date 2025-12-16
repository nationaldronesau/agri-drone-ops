import { NextRequest, NextResponse } from 'next/server';
import { elevationService } from '@/lib/services/elevation';
import { blockInProduction } from '@/lib/utils/dev-only';

/**
 * Test endpoint for validating elevation services and DSM accuracy
 */
export async function GET(request: NextRequest) {
  const prodBlock = blockInProduction();
  if (prodBlock) return prodBlock;

  try {
    const searchParams = request.nextUrl.searchParams;
    const lat = parseFloat(searchParams.get('lat') || '-27.4698'); // Brisbane default
    const lon = parseFloat(searchParams.get('lon') || '153.0251'); // Brisbane default
    
    console.log(`🗻 Testing elevation services for ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    
    // Test multiple elevation sources
    const startTime = Date.now();
    const result = await elevationService.getElevation(lat, lon);
    const queryTime = Date.now() - startTime;
    
    // Test a small grid around the point for terrain variation analysis
    const gridSize = 0.0001; // ~10 meters
    const gridPoints = [
      { lat: lat - gridSize, lon: lon - gridSize, name: 'SW' },
      { lat: lat - gridSize, lon: lon, name: 'S' },
      { lat: lat - gridSize, lon: lon + gridSize, name: 'SE' },
      { lat: lat, lon: lon - gridSize, name: 'W' },
      { lat: lat, lon: lon, name: 'CENTER' },
      { lat: lat, lon: lon + gridSize, name: 'E' },
      { lat: lat + gridSize, lon: lon - gridSize, name: 'NW' },
      { lat: lat + gridSize, lon: lon, name: 'N' },
      { lat: lat + gridSize, lon: lon + gridSize, name: 'NE' },
    ];
    
    console.log(`🔍 Testing terrain variation in ${Math.round(gridSize * 111111 * 2)}m grid`);
    
    const gridResults = await Promise.all(
      gridPoints.map(async (point) => {
        const gridStart = Date.now();
        const elevation = await elevationService.getElevation(point.lat, point.lon);
        const gridTime = Date.now() - gridStart;
        
        return {
          name: point.name,
          lat: point.lat,
          lon: point.lon,
          elevation: elevation?.elevation || null,
          source: elevation?.source || 'FAILED',
          queryTime: gridTime
        };
      })
    );
    
    // Calculate terrain statistics
    const validElevations = gridResults
      .map(r => r.elevation)
      .filter((e): e is number => e !== null);
    
    const terrainStats = validElevations.length > 0 ? {
      min: Math.min(...validElevations),
      max: Math.max(...validElevations),
      average: validElevations.reduce((a, b) => a + b, 0) / validElevations.length,
      variation: Math.max(...validElevations) - Math.min(...validElevations),
      standardDeviation: Math.sqrt(
        validElevations.reduce((sum, elevation) => {
          const avg = validElevations.reduce((a, b) => a + b, 0) / validElevations.length;
          return sum + Math.pow(elevation - avg, 2);
        }, 0) / validElevations.length
      )
    } : null;
    
    // Get cache statistics
    const cacheStats = elevationService.getCacheStats();
    
    return NextResponse.json({
      request: {
        latitude: lat,
        longitude: lon,
        isAustralian: lat >= -45 && lat <= -9 && lon >= 112 && lon <= 155
      },
      primaryResult: {
        elevation: result?.elevation || null,
        source: result?.source || 'FAILED',
        cached: result?.cached || false,
        queryTime: `${queryTime}ms`
      },
      terrainAnalysis: {
        gridSize: `${Math.round(gridSize * 111111 * 2)}m x ${Math.round(gridSize * 111111 * 2)}m`,
        gridResults,
        statistics: terrainStats ? {
          ...terrainStats,
          min: `${terrainStats.min.toFixed(1)}m`,
          max: `${terrainStats.max.toFixed(1)}m`,
          average: `${terrainStats.average.toFixed(1)}m`,
          variation: `${terrainStats.variation.toFixed(1)}m`,
          standardDeviation: `${terrainStats.standardDeviation.toFixed(2)}m`
        } : null
      },
      performanceMetrics: {
        totalQueries: gridResults.length,
        successfulQueries: validElevations.length,
        failedQueries: gridResults.length - validElevations.length,
        averageQueryTime: `${Math.round(gridResults.reduce((sum, r) => sum + r.queryTime, 0) / gridResults.length)}ms`,
        totalTime: `${Date.now() - startTime}ms`
      },
      cacheStatistics: {
        entriesInCache: cacheStats.size,
        oldestEntry: cacheStats.entries.length > 0 ? 
          `${Math.round(Math.max(...cacheStats.entries.map(e => e.age)) / 1000)}s ago` : 
          'none'
      },
      dsmReadiness: {
        elevationServiceWorking: result !== null,
        terrainVariationDetected: terrainStats ? terrainStats.variation > 1 : false,
        precisionPotential: terrainStats ? 
          (terrainStats.variation < 5 ? 'HIGH' : terrainStats.variation < 20 ? 'MEDIUM' : 'LOW') : 
          'UNKNOWN',
        recommendedIterations: terrainStats ? 
          (terrainStats.variation < 2 ? 1 : terrainStats.variation < 10 ? 2 : 3) : 
          3
      },
      testLocations: {
        brisbane: '/api/test/elevation?lat=-27.4698&lon=153.0251',
        sydney: '/api/test/elevation?lat=-33.8688&lon=151.2093',
        melbourne: '/api/test/elevation?lat=-37.8136&lon=144.9631',
        perth: '/api/test/elevation?lat=-31.9505&lon=115.8605',
        rural_qld: '/api/test/elevation?lat=-26.8468&lon=151.7831'
      }
    });
    
  } catch (error) {
    console.error('Elevation test failed:', error);
    return NextResponse.json(
      { error: 'Elevation test failed. Please try again.' },
      { status: 500 }
    );
  }
}