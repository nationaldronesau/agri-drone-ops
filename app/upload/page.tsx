import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { ImageUpload } from "@/components/features/image-upload";

export default function UploadPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/test-dashboard">
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
        <div className="max-w-4xl mx-auto">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Upload Drone Images</CardTitle>
              <CardDescription>
                Upload your drone imagery for AI-powered weed detection and georeferencing. 
                Images should contain GPS metadata for accurate coordinate conversion.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ImageUpload />
              
              <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2">Pro Tips:</h4>
                <ul className="space-y-1 text-sm text-blue-800">
                  <li>• Ensure your drone captures GPS metadata in images</li>
                  <li>• For best results, maintain consistent altitude during flight</li>
                  <li>• Images with laser rangefinder data will have more accurate georeferencing</li>
                  <li>• You can upload multiple images at once for batch processing</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}