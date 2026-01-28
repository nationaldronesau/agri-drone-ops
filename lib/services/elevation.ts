/**
 * Digital Surface Model (DSM) Elevation Service
 * 
 * Provides terrain elevation data for precision georeferencing
 * Uses SRTM data via USGS Elevation Point Query Service
 */

interface ElevationPoint {
  latitude: number;
  longitude: number;
  elevation: number; // meters above sea level
  source: string;
  cached?: boolean;
}

interface ElevationCache {
  [key: string]: {
    elevation: number;
    timestamp: number;
  };
}

class ElevationService {
  private cache: ElevationCache = {};
  private cacheExpiry = 24 * 60 * 60 * 1000; // 24 hours
  private lastRequestTime = 0;
  private minRequestInterval = 1000; // 1 second between requests to avoid rate limiting
  
  /**
   * Get elevation at a specific coordinate using multiple data sources
   * Priority: Australian Government APIs -> USGS -> Estimated
   */
  async getElevation(latitude: number, longitude: number): Promise<ElevationPoint | null> {
    const cacheKey = `${latitude.toFixed(6)},${longitude.toFixed(6)}`;
    
    // Check cache first
    const cached = this.cache[cacheKey];
    if (cached && Date.now() - cached.timestamp < this.cacheExpiry) {
      return {
        latitude,
        longitude,
        elevation: cached.elevation,
        source: 'SRTM (cached)',
        cached: true
      };
    }
    
    // Try Australian elevation services first for AU coordinates
    if (this.isAustralianCoordinate(latitude, longitude)) {
      const auResult = await this.getAustralianElevation(latitude, longitude);
      if (auResult) {
        // Cache the result
        this.cache[cacheKey] = {
          elevation: auResult.elevation,
          timestamp: Date.now()
        };
        return auResult;
      }
    }
    
    // Fallback to USGS for international coverage
    try {
      const usgsResult = await this.getUSGSElevation(latitude, longitude);
      if (usgsResult) {
        // Cache the result
        this.cache[cacheKey] = {
          elevation: usgsResult.elevation,
          timestamp: Date.now()
        };
        return usgsResult;
      }
    } catch (error) {
      console.warn(`USGS elevation query failed for ${latitude},${longitude}:`, error);
    }
    
    // Final fallback to estimated elevation
    return this.getEstimatedElevation(latitude, longitude);
  }
  
  /**
   * Check if coordinates are within Australian bounds
   */
  private isAustralianCoordinate(latitude: number, longitude: number): boolean {
    return latitude >= -45 && latitude <= -9 && longitude >= 112 && longitude <= 155;
  }
  
  /**
   * Get elevation using Open Elevation API (global coverage including Australia)
   */
  private async getAustralianElevation(latitude: number, longitude: number): Promise<ElevationPoint | null> {
    // Rate limiting to avoid 429 errors
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    if (timeSinceLastRequest < this.minRequestInterval) {
      await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
    }
    this.lastRequestTime = Date.now();
    
    try {
      // Open Elevation API provides global SRTM 30m resolution data
      const url = `https://api.open-elevation.com/api/v1/lookup?locations=${latitude},${longitude}`;
      
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'AgriDrone-Ops-Elevation-Service/1.0',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000) // 8 second timeout
      });
      
      if (!response.ok) {
        throw new Error(`Open Elevation API returned ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data?.results && data.results.length > 0 && typeof data.results[0].elevation === 'number') {
        return {
          latitude,
          longitude,
          elevation: data.results[0].elevation,
          source: 'Open Elevation SRTM',
          cached: false
        };
      }
      
      // Try alternative elevation service
      return await this.getAustralianElevationFallback(latitude, longitude);
      
    } catch (error) {
      console.warn(`Open Elevation service failed for ${latitude},${longitude}:`, error);
      return await this.getAustralianElevationFallback(latitude, longitude);
    }
  }
  
  /**
   * Fallback elevation service using MapQuest Open Elevation
   */
  private async getAustralianElevationFallback(latitude: number, longitude: number): Promise<ElevationPoint | null> {
    try {
      // MapQuest Open Elevation service (also global coverage)
      // Note: This requires an API key, so we'll just try and fall back gracefully
      const response = await fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${latitude},${longitude}`, {
        headers: {
          'User-Agent': 'AgriDrone-Ops-Elevation-Service/1.0',
          'Accept': 'application/json'
        },
        signal: AbortSignal.timeout(8000)
      });
      
      if (!response.ok) {
        throw new Error(`OpenTopoData API returned ${response.status}`);
      }
      
      const data = await response.json();
      
      if (data?.results && data.results.length > 0 && typeof data.results[0].elevation === 'number') {
        return {
          latitude,
          longitude,
          elevation: data.results[0].elevation,
          source: 'OpenTopoData SRTM',
          cached: false
        };
      }
    } catch (error) {
      console.warn(`OpenTopoData elevation service failed for ${latitude},${longitude}:`, error);
    }
    
    return null;
  }
  
  /**
   * Get elevation using USGS services (international coverage)
   */
  private async getUSGSElevation(latitude: number, longitude: number): Promise<ElevationPoint | null> {
    const url = `https://nationalmap.gov/epqs/pqs.php?x=${longitude}&y=${latitude}&units=Meters&output=json`;
    
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'AgriDrone-Ops-Elevation-Service/1.0'
      },
      timeout: 10000
    });
    
    if (!response.ok) {
      throw new Error(`USGS API returned ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data?.USGS_Elevation_Point_Query_Service?.Elevation_Query?.Elevation) {
      const elevation = parseFloat(data.USGS_Elevation_Point_Query_Service.Elevation_Query.Elevation);
      
      return {
        latitude,
        longitude,
        elevation,
        source: 'USGS SRTM',
        cached: false
      };
    }
    
    return null;
  }
  
  /**
   * Get multiple elevation points efficiently
   */
  async getElevationProfile(coordinates: Array<{lat: number, lon: number}>): Promise<ElevationPoint[]> {
    const promises = coordinates.map(coord => 
      this.getElevation(coord.lat, coord.lon)
    );
    
    const results = await Promise.allSettled(promises);
    return results
      .filter(result => result.status === 'fulfilled' && result.value !== null)
      .map(result => (result as PromiseFulfilledResult<ElevationPoint>).value);
  }
  
  /**
   * Estimated elevation for Australian regions (fallback)
   */
  private getEstimatedElevation(latitude: number, longitude: number): ElevationPoint {
    let elevation = 100; // Default elevation for eastern Australia
    
    // Brisbane/Gold Coast region (coastal)
    if (latitude >= -28 && latitude <= -26 && longitude >= 152 && longitude <= 154) {
      elevation = 50;
    }
    // Sydney region (coastal to inland)
    else if (latitude >= -35 && latitude <= -32 && longitude >= 150 && longitude <= 152) {
      elevation = 100;
    }
    // Melbourne region
    else if (latitude >= -39 && latitude <= -36 && longitude >= 144 && longitude <= 146) {
      elevation = 150;
    }
    // Great Dividing Range
    else if (longitude >= 147 && longitude <= 153) {
      elevation = 300;
    }
    // Inland areas
    else if (longitude < 147) {
      elevation = 200;
    }
    
    return {
      latitude,
      longitude,
      elevation,
      source: 'Estimated (AU)',
      cached: false
    };
  }
  
  /**
   * Calculate terrain slope between two points (for advanced corrections)
   */
  async getTerrainSlope(
    lat1: number, lon1: number, 
    lat2: number, lon2: number
  ): Promise<number> {
    const [point1, point2] = await Promise.all([
      this.getElevation(lat1, lon1),
      this.getElevation(lat2, lon2)
    ]);
    
    if (!point1 || !point2) return 0;
    
    const elevationDiff = point2.elevation - point1.elevation;
    const distance = this.calculateDistance(lat1, lon1, lat2, lon2);
    
    return distance > 0 ? Math.atan(elevationDiff / distance) * 180 / Math.PI : 0;
  }
  
  /**
   * Calculate distance between two points in meters
   */
  private calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371000; // Earth's radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
  }
  
  /**
   * Clear elevation cache (for testing/debugging)
   */
  clearCache(): void {
    this.cache = {};
  }
  
  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number, entries: Array<{key: string, age: number}> } {
    const entries = Object.entries(this.cache).map(([key, value]) => ({
      key,
      age: Date.now() - value.timestamp
    }));
    
    return {
      size: entries.length,
      entries
    };
  }
}

// Singleton instance
export const elevationService = new ElevationService();

// Type exports
export type { ElevationPoint };

/**
 * Convenience function for single elevation queries
 */
export async function getTerrainElevation(latitude: number, longitude: number): Promise<number> {
  const result = await elevationService.getElevation(latitude, longitude);
  return result?.elevation || 100; // Default fallback elevation
}

/**
 * High-performance batch elevation queries with error handling
 */
export async function getTerrainElevationBatch(
  coordinates: Array<{lat: number, lon: number}>
): Promise<number[]> {
  try {
    const results = await elevationService.getElevationProfile(coordinates);
    return results.map(r => r.elevation);
  } catch (error) {
    console.warn('Batch elevation query failed:', error);
    // Return estimated elevations as fallback
    return coordinates.map(() => 100);
  }
}
