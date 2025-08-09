"use client";

import dynamic from "next/dynamic";

// Dynamically load MapComponent only in browser
const MapComponent = dynamic(() => import("@/components/map-component"), {
  ssr: false, // <-- This is the key to avoid server rendering
  loading: () => <p>Loading map...</p>, // Optional: loader UI
});

export default function MapPageWrapper() {
  return <MapComponent />;
}
