"use client";

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

type GpsFinding = { path: string; value: number; key: string; note?: string };
type GpsAnalysis = {
  potentialLatitudes: GpsFinding[];
  potentialLongitudes: GpsFinding[];
  potentialAltitudes: GpsFinding[];
  gimbalFields: GpsFinding[];
  lrfFields: GpsFinding[];
};
type LibraryEntry = Record<string, unknown> & { error?: string };
type MultiExifResult = {
  gpsAnalysis: GpsAnalysis;
  libraries: Record<string, LibraryEntry>;
  [key: string]: unknown;
};

export default function MultiDebugPage() {
  const [result, setResult] = useState<MultiExifResult | null>(null);
  const [loading, setLoading] = useState(false);

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/debug/multi-exif', {
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
          <CardTitle>Multi-Library EXIF Debug Tool</CardTitle>
          <p className="text-sm text-gray-600">
            Tests your image with 4 different EXIF libraries to find GPS data
          </p>
        </CardHeader>
        <CardContent>
          <input
            type="file"
            onChange={handleFileUpload}
            accept="image/*"
            className="mb-4"
          />
          
          {loading && <p>Analyzing with multiple libraries...</p>}
          
          {result && (
            <div className="space-y-6">
              <div className="bg-blue-50 p-4 rounded-lg">
                <h3 className="font-bold text-blue-900 mb-2">File Info</h3>
                <p><strong>Name:</strong> {result.filename}</p>
                <p><strong>Size:</strong> {(result.fileSize / 1024 / 1024).toFixed(2)} MB</p>
                <p><strong>Type:</strong> {result.mimeType}</p>
              </div>

              <div className="bg-green-50 p-4 rounded-lg">
                <h3 className="font-bold text-green-900 mb-2">🎯 GPS Analysis Results</h3>
                
                {result.gpsAnalysis.potentialLatitudes.length > 0 && (
                  <div className="mb-3">
                    <h4 className="font-semibold">Potential Latitudes Found:</h4>
                    {result.gpsAnalysis.potentialLatitudes.map((item, i: number) => (
                      <div key={i} className="ml-4 text-sm">
                        <code>{item.path}</code>: <strong>{item.value}</strong>
                        {item.note && <span className="text-orange-600"> ({item.note})</span>}
                      </div>
                    ))}
                  </div>
                )}
                
                {result.gpsAnalysis.potentialLongitudes.length > 0 && (
                  <div className="mb-3">
                    <h4 className="font-semibold">Potential Longitudes Found:</h4>
                    {result.gpsAnalysis.potentialLongitudes.map((item, i: number) => (
                      <div key={i} className="ml-4 text-sm">
                        <code>{item.path}</code>: <strong>{item.value}</strong>
                        {item.note && <span className="text-orange-600"> ({item.note})</span>}
                      </div>
                    ))}
                  </div>
                )}
                
                {result.gpsAnalysis.potentialAltitudes.length > 0 && (
                  <div className="mb-3">
                    <h4 className="font-semibold">Potential Altitudes Found:</h4>
                    {result.gpsAnalysis.potentialAltitudes.map((item, i: number) => (
                      <div key={i} className="ml-4 text-sm">
                        <code>{item.path}</code>: <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                )}

                {result.gpsAnalysis.gimbalFields.length > 0 && (
                  <div className="mb-3">
                    <h4 className="font-semibold">Gimbal Fields Found:</h4>
                    {result.gpsAnalysis.gimbalFields.map((item, i: number) => (
                      <div key={i} className="ml-4 text-sm">
                        <code>{item.path}</code>: <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                )}
                
                {result.gpsAnalysis.lrfFields.length > 0 && (
                  <div className="mb-3">
                    <h4 className="font-semibold">LRF Fields Found:</h4>
                    {result.gpsAnalysis.lrfFields.map((item, i: number) => (
                      <div key={i} className="ml-4 text-sm">
                        <code>{item.path}</code>: <strong>{item.value}</strong>
                      </div>
                    ))}
                  </div>
                )}
                
                {result.gpsAnalysis.potentialLatitudes.length === 0 && 
                 result.gpsAnalysis.potentialLongitudes.length === 0 && (
                  <p className="text-orange-600 font-semibold">
                    ⚠️ No GPS coordinates found in any library
                  </p>
                )}
              </div>

              {Object.entries(result.libraries).map(([libName, libData]) => (
                <div key={libName}>
                  <h3 className="font-bold mb-2 capitalize">{libName} Results:</h3>
                  {libData.error ? (
                    <p className="text-red-600">Error: {libData.error}</p>
                  ) : (
                    <div className="grid md:grid-cols-2 gap-4">
                      {Object.entries(libData).map(([key, value]) => (
                        <div key={key}>
                          <h4 className="font-semibold text-sm">{key}:</h4>
                          <pre className="bg-gray-100 p-2 rounded text-xs overflow-auto max-h-48">
                            {JSON.stringify(value, null, 2)}
                          </pre>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
