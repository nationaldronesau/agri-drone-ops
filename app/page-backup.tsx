import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap, Map, Upload, Users, BarChart3, Shield } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted">
      <header className="container mx-auto px-4 py-6">
        <nav className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="w-10 h-10 gradient-primary rounded-lg"></div>
            <span className="text-2xl font-bold gradient-text">AgriDrone Ops</span>
          </div>
          <div className="flex items-center space-x-4">
            <Link href="/auth/signin">
              <Button variant="ghost">Sign In</Button>
            </Link>
            <Link href="/auth/signup">
              <Button>Get Started</Button>
            </Link>
          </div>
        </nav>
      </header>

      <main className="container mx-auto px-4 py-16">
        <section className="text-center mb-20 animate-in">
          <h1 className="text-5xl md:text-6xl font-bold mb-6 gradient-text">
            Agricultural Drone Operations Platform
          </h1>
          <p className="text-xl text-muted-foreground mb-8 max-w-3xl mx-auto">
            Transform your drone imagery into actionable insights. Detect weeds and crops with AI, 
            manually annotate targets, and generate precise spray coordinates for your operations.
          </p>
          <div className="flex gap-4 justify-center">
            <Link href="/auth/signup">
              <Button size="lg" className="gradient-primary text-white">
                Start Free Trial
              </Button>
            </Link>
            <Link href="#features">
              <Button size="lg" variant="outline">
                Learn More
              </Button>
            </Link>
          </div>
        </section>

        <section id="features" className="grid md:grid-cols-3 gap-8 mb-20">
          <Card className="animate-in hover:shadow-lg transition-shadow">
            <CardHeader>
              <Upload className="w-12 h-12 text-primary mb-4" />
              <CardTitle>Upload & Process</CardTitle>
              <CardDescription>
                Batch upload thousands of drone images with automatic metadata extraction
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="text-sm text-muted-foreground space-y-2">
                <li>• EXIF metadata extraction</li>
                <li>• GPS coordinates & camera data</li>
                <li>• Laser rangefinder support</li>
              </ul>
            </CardContent>
          </Card>

          <Card className="animate-in hover:shadow-lg transition-shadow" style={{animationDelay: "100ms"}}>
            <CardHeader>
              <Zap className="w-12 h-12 text-primary mb-4" />
              <CardTitle>AI Detection</CardTitle>
              <CardDescription>
                Powered by Roboflow models trained on wattle, lantana, and more species
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="text-sm text-muted-foreground space-y-2">
                <li>• Pre-trained weed models</li>
                <li>• Manual annotation tools</li>
                <li>• Confidence scoring</li>
              </ul>
            </CardContent>
          </Card>

          <Card className="animate-in hover:shadow-lg transition-shadow" style={{animationDelay: "200ms"}}>
            <CardHeader>
              <Map className="w-12 h-12 text-primary mb-4" />
              <CardTitle>Geo-Coordinates</CardTitle>
              <CardDescription>
                Convert detections to precise geographic coordinates for spray drones
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="text-sm text-muted-foreground space-y-2">
                <li>• Pixel to geo conversion</li>
                <li>• Terrain height correction</li>
                <li>• Export to CSV/KML</li>
              </ul>
            </CardContent>
          </Card>
        </section>

        <section className="grid md:grid-cols-2 gap-12 items-center mb-20">
          <div className="space-y-6">
            <h2 className="text-4xl font-bold">Complete Workflow Management</h2>
            <p className="text-lg text-muted-foreground">
              From drone flight to spray coordinates, manage your entire agricultural 
              drone operation in one platform.
            </p>
            <div className="space-y-4">
              <div className="flex items-start gap-4">
                <Users className="w-6 h-6 text-primary mt-1" />
                <div>
                  <h3 className="font-semibold">Team Collaboration</h3>
                  <p className="text-sm text-muted-foreground">
                    Create teams, manage permissions, and collaborate on projects
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <BarChart3 className="w-6 h-6 text-primary mt-1" />
                <div>
                  <h3 className="font-semibold">Historical Analysis</h3>
                  <p className="text-sm text-muted-foreground">
                    Compare farm data over time and track treatment effectiveness
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-4">
                <Shield className="w-6 h-6 text-primary mt-1" />
                <div>
                  <h3 className="font-semibold">Chemical Recommendations</h3>
                  <p className="text-sm text-muted-foreground">
                    Get species-specific treatment recommendations and dosage calculations
                  </p>
                </div>
              </div>
            </div>
          </div>
          <div className="relative">
            <div className="aspect-video bg-gradient-to-br from-primary/20 to-secondary/20 rounded-lg"></div>
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center">
                <Map className="w-24 h-24 text-primary/50 mx-auto mb-4" />
                <p className="text-sm text-muted-foreground">Interactive Map Visualization</p>
              </div>
            </div>
          </div>
        </section>

        <section className="text-center py-20 bg-muted rounded-lg">
          <h2 className="text-3xl font-bold mb-4">Ready to Transform Your Agricultural Operations?</h2>
          <p className="text-lg text-muted-foreground mb-8">
            Join farmers using AI to optimize their spray operations
          </p>
          <Link href="/auth/signup">
            <Button size="lg" className="gradient-primary text-white">
              Start Your Free Trial
            </Button>
          </Link>
        </section>
      </main>

      <footer className="container mx-auto px-4 py-8 border-t">
        <div className="flex justify-between items-center">
          <p className="text-sm text-muted-foreground">
            © 2024 AgriDrone Ops by National Drones. All rights reserved.
          </p>
          <div className="flex gap-4">
            <Link href="/privacy" className="text-sm text-muted-foreground hover:text-foreground">
              Privacy
            </Link>
            <Link href="/terms" className="text-sm text-muted-foreground hover:text-foreground">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}