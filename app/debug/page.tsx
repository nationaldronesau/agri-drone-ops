"use client";

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export default function DebugPage() {
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/debug/exif', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      setResult(data);
    } catch (error) {
      console.error('Error:', error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto p-8">
      <Card>
        <CardHeader>
          <CardTitle>EXIF Debug Tool</CardTitle>
        </CardHeader>
        <CardContent>
          <input
            type="file"
            onChange={handleFileUpload}
            accept="image/*"
            className="mb-4"
          />
          
          {loading && <p>Analyzing...</p>}
          
          {result && (
            <div className="space-y-4">
              <div>
                <h3 className="font-bold">All Fields Found:</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-48">
                  {JSON.stringify(result.allFields, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">GPS Data:</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-48">
                  {JSON.stringify(result.gpsData, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">All Metadata:</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.allMetadata, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">Full Metadata (with XMP):</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.fullMetadata, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">XMP Data:</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.xmpData, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">Raw EXIF (Untranslated):</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.rawExif, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">Maker Notes (DJI-specific):</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.makerNotes, null, 2)}
                </pre>
              </div>
              
              <div>
                <h3 className="font-bold">GPS/Location Fields Found:</h3>
                <div className="bg-gray-100 p-2 rounded text-xs">
                  <p><strong>IFD0 GPS fields:</strong> {JSON.stringify(result.gpsInIfd0)}</p>
                  <p><strong>EXIF GPS fields:</strong> {JSON.stringify(result.gpsInExif)}</p>
                  <p><strong>XMP GPS fields:</strong> {JSON.stringify(result.gpsInXmp)}</p>
                </div>
              </div>
              
              <div>
                <h3 className="font-bold">Numeric GPS/LRF/Gimbal Fields:</h3>
                <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-96">
                  {JSON.stringify(result.numericFields, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}