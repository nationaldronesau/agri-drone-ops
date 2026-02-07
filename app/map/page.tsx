"use client";

import dynamic from "next/dynamic";

// Dynamically load MapComponent only in browser
const MapComponent = dynamic(() => import("@/components/map-component"), {
  ssr: false, // <-- This is the key to avoid server rendering
  loading: () => (
    <div className="flex h-[calc(100vh-2rem)] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-violet-600" />
        <p className="text-sm text-gray-500">Loading map...</p>
      </div>
    </div>
  ),
});

export default function MapPageWrapper() {
  return <MapComponent />;
}
