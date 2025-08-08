"use client";

import dynamic from 'next/dynamic';

// Dynamically import map components to avoid SSR issues
const DynamicMap = dynamic(
  () => import('./map-view').then((mod) => mod.MapView),
  { 
    ssr: false,
    loading: () => (
      <div className="flex items-center justify-center h-[600px]">
        <p>Loading map...</p>
      </div>
    )
  }
);

export { DynamicMap };