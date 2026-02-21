import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, Map, Download, Sparkles, ArrowRight, Images, Route, Activity } from "lucide-react";
import Link from "next/link";

export default function Dashboard() {
  return (
    <div className="p-6 lg:p-8">
      {/* Welcome Section */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-1">Welcome back</h1>
        <p className="text-gray-500">Manage your agricultural drone operations and AI-powered weed detection.</p>
      </div>

      {/* Quick Actions — compact row */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {[
          { label: "Upload", href: "/upload", icon: Upload, color: "text-green-600" },
          { label: "Images", href: "/images", icon: Images, color: "text-blue-600" },
          { label: "Map", href: "/map", icon: Map, color: "text-blue-600" },
          { label: "Planner", href: "/mission-planner", icon: Route, color: "text-cyan-700" },
          { label: "Insights", href: "/insights", icon: Activity, color: "text-indigo-600" },
          { label: "Export", href: "/export", icon: Download, color: "text-orange-600" },
          { label: "Training Hub", href: "/training-hub", icon: Sparkles, color: "text-violet-600" },
        ].map((action) => (
          <Link key={action.href} href={action.href}>
            <Card className="hover:shadow-md hover:border-violet-200 transition-all cursor-pointer group">
              <CardContent className="flex items-center gap-3 p-4">
                <action.icon className={`h-5 w-5 ${action.color}`} />
                <span className="text-sm font-medium text-gray-700 group-hover:text-gray-900">{action.label}</span>
                <ArrowRight className="ml-auto h-3.5 w-3.5 text-gray-300 group-hover:text-violet-400 transition-colors" />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {/* Main Grid */}
      <div className="grid lg:grid-cols-3 gap-6">
        {/* Recent Projects */}
        <div className="lg:col-span-2">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-4">
              <div>
                <CardTitle className="text-lg">Recent Projects</CardTitle>
                <CardDescription>Your latest agricultural drone projects</CardDescription>
              </div>
              <Link href="/projects">
                <Button variant="outline" size="sm">View All</Button>
              </Link>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/50 p-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-900">Farm Block A - Wattle Detection</h3>
                    <p className="text-xs text-gray-500 mt-0.5">1,245 images &middot; 89 detections &middot; 2 days ago</p>
                  </div>
                  <Link href="/projects">
                    <Button variant="ghost" size="sm" className="text-xs">View</Button>
                  </Link>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/50 p-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-900">Southern Paddock Survey</h3>
                    <p className="text-xs text-gray-500 mt-0.5">856 images &middot; 156 detections &middot; 5 days ago</p>
                  </div>
                  <Link href="/projects">
                    <Button variant="ghost" size="sm" className="text-xs">View</Button>
                  </Link>
                </div>
                <div className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50/50 p-4">
                  <div>
                    <h3 className="text-sm font-medium text-gray-900">Lantana Mapping Project</h3>
                    <p className="text-xs text-gray-500 mt-0.5">2,103 images &middot; 234 detections &middot; 1 week ago</p>
                  </div>
                  <Link href="/projects">
                    <Button variant="ghost" size="sm" className="text-xs">View</Button>
                  </Link>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Stats sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Processing Stats</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Images Processed</span>
                <span className="font-semibold text-gray-900">4,204</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">AI Detections</span>
                <span className="font-semibold text-gray-900">479</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Manual Annotations</span>
                <span className="font-semibold text-gray-900">156</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Active Projects</span>
                <span className="font-semibold text-gray-900">3</span>
              </div>
              <div className="pt-3 border-t">
                <div className="flex justify-between mb-1.5">
                  <span className="text-gray-500">Storage Used</span>
                  <span className="text-xs font-medium">2.4 GB / 10 GB</span>
                </div>
                <div className="w-full rounded-full bg-gray-100 h-1.5">
                  <div className="h-1.5 rounded-full bg-gradient-to-r from-violet-500 to-blue-500" style={{width: '24%'}} />
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-lg">Quick Tips</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2.5 text-sm text-gray-600">
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  <p>Upload images with GPS metadata for automatic georeferencing</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-violet-500 flex-shrink-0" />
                  <p>Use manual annotation to improve AI model accuracy</p>
                </div>
                <div className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 flex-shrink-0" />
                  <p>Export coordinates as CSV/KML for your spray drones</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
