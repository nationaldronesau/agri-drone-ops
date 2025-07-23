'use client';

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

// Fix leaflet default marker icon issue
if (typeof window !== 'undefined') {
  delete (L.Icon.Default.prototype as any)._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
    iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
    shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  });
}

interface OrthomosaicMapProps {
  orthomosaic: {
    id: string;
    name: string;
    bounds: any;
    centerLat: number;
    centerLon: number;
    minZoom: number;
    maxZoom: number;
    tilesetPath?: string;
  };
  controls: {
    showLayers: boolean;
    showMeasurement: boolean;
    opacity: number;
  };
  onControlsChange: (controls: any) => void;
}

export default function OrthomosaicMap({ orthomosaic, controls, onControlsChange }: OrthomosaicMapProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<L.Map | null>(null);
  const orthomosaicLayer = useRef<L.TileLayer | null>(null);

  useEffect(() => {
    if (!mapRef.current || mapInstance.current) return;

    // Initialize map
    const map = L.map(mapRef.current, {
      center: [orthomosaic.centerLat, orthomosaic.centerLon],
      zoom: Math.min(orthomosaic.maxZoom - 2, 15),
      minZoom: orthomosaic.minZoom,
      maxZoom: orthomosaic.maxZoom,
    });

    mapInstance.current = map;

    // Add base layers
    const sateliteLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Esri, DigitalGlobe, GeoEye, Earthstar Geographics, CNES/Airbus DS, USDA, USGS, AeroGRID, IGN, and the GIS User Community',
      maxZoom: 19,
    }).addTo(map);

    const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    });

    // Add orthomosaic layer
    // For now, we'll use a placeholder/demo tile layer since we don't have actual tiles yet
    const orthomosaicTileLayer = L.tileLayer(`/api/tiles/${orthomosaic.id}/{z}/{x}/{y}.png`, {
      attribution: `© ${orthomosaic.name}`,
      opacity: controls.opacity,
      maxZoom: orthomosaic.maxZoom,
      minZoom: orthomosaic.minZoom,
      // For demo purposes, fall back to satellite imagery
      errorTileUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    });

    orthomosaicLayer.current = orthomosaicTileLayer;

    // Add orthomosaic bounds as overlay for visualization
    if (orthomosaic.bounds && orthomosaic.bounds.coordinates) {
      const bounds = orthomosaic.bounds.coordinates[0];
      if (bounds && bounds.length >= 4) {
        const polygon = L.polygon(
          bounds.map((coord: [number, number]) => [coord[1], coord[0]]), // Convert [lon, lat] to [lat, lon]
          {
            color: '#3b82f6',
            weight: 2,
            opacity: 0.8,
            fillColor: '#3b82f6',
            fillOpacity: 0.1,
          }
        ).addTo(map);

        // Fit map to orthomosaic bounds with padding
        map.fitBounds(polygon.getBounds(), { padding: [20, 20] });
        
        // Add popup to bounds
        polygon.bindPopup(`
          <div class="p-2">
            <h3 class="font-semibold text-gray-900">${orthomosaic.name}</h3>
            <p class="text-sm text-gray-600">Orthomosaic Coverage Area</p>
            <p class="text-xs text-gray-500 mt-1">Click "Add Orthomosaic Layer" to view imagery</p>
          </div>
        `);
      }
    }

    // Layer control
    const baseLayers = {
      'Satellite': sateliteLayer,
      'OpenStreetMap': osmLayer,
    };

    const overlayLayers = {
      'Orthomosaic': orthomosaicTileLayer,
    };

    const layerControl = L.control.layers(baseLayers, overlayLayers, {
      position: 'topleft',
      collapsed: !controls.showLayers,
    }).addTo(map);

    // Scale control
    L.control.scale({
      position: 'bottomleft',
      metric: true,
      imperial: false,
    }).addTo(map);

    // Add center marker
    L.marker([orthomosaic.centerLat, orthomosaic.centerLon])
      .addTo(map)
      .bindPopup(`
        <div class="p-2">
          <h3 class="font-semibold text-gray-900">${orthomosaic.name}</h3>
          <p class="text-sm text-gray-600">Center Point</p>
          <p class="text-xs text-gray-500">${orthomosaic.centerLat.toFixed(6)}, ${orthomosaic.centerLon.toFixed(6)}</p>
        </div>
      `);

    // Cleanup function
    return () => {
      if (mapInstance.current) {
        mapInstance.current.remove();
        mapInstance.current = null;
      }
    };
  }, [orthomosaic]);

  // Update opacity when controls change
  useEffect(() => {
    if (orthomosaicLayer.current) {
      orthomosaicLayer.current.setOpacity(controls.opacity);
    }
  }, [controls.opacity]);

  return (
    <div className="relative">
      <div 
        ref={mapRef} 
        className="w-full h-[600px] rounded-lg border border-gray-200"
        style={{ minHeight: '600px' }}
      />
      
      {/* Demo Notice */}
      <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur-sm rounded-lg p-3 shadow-lg max-w-xs">
        <div className="text-xs text-gray-600">
          <strong>Demo Mode:</strong> Orthomosaic tiles are simulated. The blue outlined area shows where your orthomosaic imagery would be displayed once tile processing is implemented.
        </div>
      </div>
    </div>
  );
}