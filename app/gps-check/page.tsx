"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, MapPin, AlertCircle, CheckCircle } from "lucide-react";
import Link from "next/link";

interface GPSCheckResult {
  total: number;
  withGPS: {
    count: number;
    assets: {
      id: string;
      fileName: string;
      gpsLatitude: number | null;
      gpsLongitude: number | null;
      altitude: number | null;
      metadata: unknown | null;
    }[];
  };
  withoutGPS: {
    count: number;
    assets: {
      id: string;
      fileName: string;
      hasMetadata: boolean;
    }[];
  };
}

export default function GPSCheckPage() {
  const [result, setResult] = useState<GPSCheckResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchGPSCheck();
  }, []);

  const fetchGPSCheck = async () => {
    try {
      const response = await fetch('/api/check-gps');
      if (response.ok) {
        const data = await response.json();
        setResult(data);
      }
    } catch (error) {
      console.error('Failed to check GPS:', error);
    } finally {
      setLoading(false);
    }
  };

  const addSampleGPS = async () => {
    // For testing, let's add sample GPS data to images without GPS
    try {
      const response = await fetch('/api/add-sample-gps', {
        method: 'POST'
      });
      if (response.ok) {
        fetchGPSCheck(); // Refresh
        alert('Sample GPS data added to images without GPS!');
      }
    } catch (error) {
      console.error('Failed to add sample GPS:', error);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/dashboard">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg"></div>
                <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">GPS Data Check</h1>
          <p className="text-gray-600">
            Check which uploaded images have GPS coordinates
          </p>
        </div>

        {loading ? (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-gray-500">Checking GPS data...</p>
            </CardContent>
          </Card>
        ) : result ? (
          <div className="space-y-6">
            {/* Summary */}
            <div className="grid md:grid-cols-3 gap-4">
              <Card>
                <CardContent className="p-6 text-center">
                  <div className="text-2xl font-bold text-gray-900">{result.total}</div>
                  <p className="text-gray-600">Total Images</p>
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-6 text-center">
                  <div className="text-2xl font-bold text-green-600">{result.withGPS.count}</div>
                  <p className="text-gray-600">With GPS</p>
                  <CheckCircle className="w-6 h-6 text-green-500 mx-auto mt-2" />
                </CardContent>
              </Card>
              
              <Card>
                <CardContent className="p-6 text-center">
                  <div className="text-2xl font-bold text-orange-600">{result.withoutGPS.count}</div>
                  <p className="text-gray-600">Without GPS</p>
                  <AlertCircle className="w-6 h-6 text-orange-500 mx-auto mt-2" />
                </CardContent>
              </Card>
            </div>

            {/* Images with GPS */}
            {result.withGPS.count > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <CheckCircle className="w-5 h-5 text-green-500" />
                    Images with GPS Data
                  </CardTitle>
                  <CardDescription>These images can be displayed on the map</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2">
                    {result.withGPS.assets.map((asset) => (
                      <div key={asset.id} className="flex items-center justify-between p-3 bg-green-50 rounded-lg">
                        <span className="font-medium">{asset.fileName}</span>
                        <span className="text-sm text-gray-600">
                          {asset.gpsLatitude?.toFixed(6)}, {asset.gpsLongitude?.toFixed(6)}
                          {asset.altitude && ` • ${Math.round(asset.altitude)}m`}
                        </span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4">
                    <Link href="/map">
                      <Button className="bg-green-600 hover:bg-green-700">
                        <MapPin className="w-4 h-4 mr-2" />
                        View on Map
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Images without GPS */}
            {result.withoutGPS.count > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <AlertCircle className="w-5 h-5 text-orange-500" />
                    Images without GPS Data
                  </CardTitle>
                  <CardDescription>
                    These images cannot be displayed on the map. GPS may have been disabled or stripped during processing.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 mb-4">
                    {result.withoutGPS.assets.map((asset) => (
                      <div key={asset.id} className="flex items-center justify-between p-3 bg-orange-50 rounded-lg">
                        <span className="font-medium">{asset.fileName}</span>
                        <span className="text-sm text-gray-600">
                          {asset.hasMetadata ? 'Has EXIF but no GPS' : 'No EXIF data'}
                        </span>
                      </div>
                    ))}
                  </div>
                  
                  <div className="bg-blue-50 p-4 rounded-lg">
                    <h4 className="font-semibold text-blue-900 mb-2">For Testing Purposes:</h4>
                    <p className="text-sm text-blue-800 mb-3">
                      Add sample GPS coordinates to these images so you can test the map and export features.
                    </p>
                    <Button 
                      onClick={addSampleGPS}
                      variant="outline"
                      className="border-blue-300 text-blue-700 hover:bg-blue-100"
                    >
                      Add Sample GPS Data
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {result.total === 0 && (
              <Card>
                <CardContent className="p-8 text-center">
                  <p className="text-gray-500 mb-4">No images uploaded yet</p>
                  <Link href="/upload">
                    <Button>Upload Your First Image</Button>
                  </Link>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <Card>
            <CardContent className="p-8 text-center">
              <p className="text-red-500">Failed to load GPS data</p>
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
