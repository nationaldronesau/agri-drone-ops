import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Zap, Map, Plus, FolderOpen, Users, Settings, Folder, Download, Mountain } from "lucide-react";
import Link from "next/link";

export default function TestDashboard() {
  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg"></div>
              <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                AgriDrone Ops
              </span>
            </div>
            <div className="flex items-center space-x-4">
              <Button variant="ghost" size="sm">
                <Users className="w-4 h-4 mr-2" />
                My Team
              </Button>
              <Button variant="ghost" size="sm">
                <Settings className="w-4 h-4 mr-2" />
                Settings
              </Button>
              <Button variant="outline" size="sm">
                Sign Out
              </Button>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Welcome to AgriDrone Ops</h1>
          <p className="text-gray-600">Manage your agricultural drone operations and AI-powered weed detection.</p>
        </div>

        {/* Quick Actions */}
        <div className="grid md:grid-cols-3 lg:grid-cols-5 gap-6 mb-8">
          <Link href="/projects">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-blue-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Folder className="w-8 h-8 text-blue-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">Projects</CardTitle>
                <CardDescription>Manage your survey projects</CardDescription>
              </CardContent>
            </Card>
          </Link>

          <Link href="/upload">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-green-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Upload className="w-8 h-8 text-green-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">Upload Images</CardTitle>
                <CardDescription>Upload drone imagery for processing</CardDescription>
              </CardContent>
            </Card>
          </Link>

          <Link href="/images">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-green-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Zap className="w-8 h-8 text-green-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">View Images</CardTitle>
                <CardDescription>See uploaded images with GPS data</CardDescription>
              </CardContent>
            </Card>
          </Link>

          <Link href="/map">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-blue-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Map className="w-8 h-8 text-blue-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">View Map</CardTitle>
                <CardDescription>See images & detections on map</CardDescription>
              </CardContent>
            </Card>
          </Link>

          <Link href="/export">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-orange-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Download className="w-8 h-8 text-orange-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">Export Data</CardTitle>
                <CardDescription>Export detections for spray drones</CardDescription>
              </CardContent>
            </Card>
          </Link>

          <Link href="/orthomosaics">
            <Card className="hover:shadow-lg transition-shadow cursor-pointer border-purple-200">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between">
                  <Mountain className="w-8 h-8 text-purple-600" />
                  <Plus className="w-5 h-5 text-gray-400" />
                </div>
              </CardHeader>
              <CardContent>
                <CardTitle className="text-lg mb-2">Orthomosaics</CardTitle>
                <CardDescription>View stitched drone imagery</CardDescription>
              </CardContent>
            </Card>
          </Link>
        </div>

        {/* Recent Projects */}
        <div className="grid lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <CardTitle>Recent Projects</CardTitle>
                <CardDescription>Your latest agricultural drone projects</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                    <div>
                      <h3 className="font-medium text-gray-900">Farm Block A - Wattle Detection</h3>
                      <p className="text-sm text-gray-600">1,245 images • 89 detections • 2 days ago</p>
                    </div>
                    <Button variant="ghost" size="sm">View</Button>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                    <div>
                      <h3 className="font-medium text-gray-900">Southern Paddock Survey</h3>
                      <p className="text-sm text-gray-600">856 images • 156 detections • 5 days ago</p>
                    </div>
                    <Button variant="ghost" size="sm">View</Button>
                  </div>
                  <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                    <div>
                      <h3 className="font-medium text-gray-900">Lantana Mapping Project</h3>
                      <p className="text-sm text-gray-600">2,103 images • 234 detections • 1 week ago</p>
                    </div>
                    <Button variant="ghost" size="sm">View</Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>

          <div>
            <Card>
              <CardHeader>
                <CardTitle>Processing Stats</CardTitle>
                <CardDescription>Your account overview</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between">
                  <span className="text-gray-600">Images Processed</span>
                  <span className="font-medium">4,204</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">AI Detections</span>
                  <span className="font-medium">479</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Manual Annotations</span>
                  <span className="font-medium">156</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-600">Active Projects</span>
                  <span className="font-medium">3</span>
                </div>
                <div className="pt-4 border-t">
                  <div className="flex justify-between mb-2">
                    <span className="text-gray-600">Storage Used</span>
                    <span className="text-sm">2.4 GB / 10 GB</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2">
                    <div className="bg-gradient-to-r from-green-500 to-blue-500 h-2 rounded-full" style={{width: '24%'}}></div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="mt-6">
              <CardHeader>
                <CardTitle>Quick Tips</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-3 text-sm">
                  <div className="flex items-start gap-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                    <p>Upload images with GPS metadata for automatic georeferencing</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-2 h-2 bg-blue-500 rounded-full mt-2"></div>
                    <p>Use manual annotation to improve AI model accuracy</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <div className="w-2 h-2 bg-green-500 rounded-full mt-2"></div>
                    <p>Export coordinates as CSV/KML for your spray drones</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </main>
    </div>
  );
}