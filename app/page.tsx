import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Zap, Map, Upload, Users, BarChart3, Shield, ArrowRight, Check, Crosshair } from "lucide-react";

export default function Home() {
  return (
    <div className="min-h-screen bg-slate-950 text-white overflow-hidden">
      {/* Ambient background */}
      <div className="fixed inset-0 pointer-events-none">
        <div className="absolute top-0 left-1/4 w-[800px] h-[800px] bg-green-500/10 rounded-full blur-[120px]" />
        <div className="absolute bottom-0 right-1/4 w-[600px] h-[600px] bg-blue-500/10 rounded-full blur-[100px]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_0%,rgba(2,6,23,0.8)_70%)]" />
        {/* Grid overlay */}
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                              linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
            backgroundSize: '60px 60px'
          }}
        />
      </div>

      <div className="relative">
        {/* Header */}
        <header className="container mx-auto px-6 py-6">
          <nav className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {/* Logo mark */}
              <div className="relative w-11 h-11">
                <div className="absolute inset-0 bg-gradient-to-br from-green-400 to-blue-500 rounded-xl rotate-3 opacity-80" />
                <div className="absolute inset-0 bg-gradient-to-br from-green-400 to-blue-500 rounded-xl flex items-center justify-center">
                  <Crosshair className="w-6 h-6 text-white" strokeWidth={2.5} />
                </div>
              </div>
              <div className="flex flex-col">
                <span className="text-xl font-bold tracking-tight text-white">
                  National Drones
                </span>
                <span className="text-[10px] uppercase tracking-[0.2em] text-green-400/80 font-medium">
                  AgriDrone Ops
                </span>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <Link href="/dashboard">
                <Button variant="ghost" className="text-slate-300 hover:text-white hover:bg-white/5">
                  Dashboard
                </Button>
              </Link>
              <Link href="/auth/signin">
                <Button variant="ghost" className="text-slate-300 hover:text-white hover:bg-white/5">
                  Sign In
                </Button>
              </Link>
              <Link href="/auth/signup">
                <Button className="bg-gradient-to-r from-green-500 to-emerald-400 text-slate-950 font-semibold hover:from-green-400 hover:to-emerald-300 shadow-lg shadow-green-500/20">
                  Get Started
                </Button>
              </Link>
            </div>
          </nav>
        </header>

        {/* Hero Section */}
        <main className="container mx-auto px-6">
          <section className="pt-20 pb-32 text-center relative">
            {/* Decorative elements */}
            <div className="absolute top-32 left-12 w-px h-32 bg-gradient-to-b from-green-500/50 to-transparent" />
            <div className="absolute top-32 right-12 w-px h-32 bg-gradient-to-b from-blue-500/50 to-transparent" />

            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 mb-8 backdrop-blur-sm">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
              <span className="text-sm text-slate-300">Precision Agriculture Technology</span>
            </div>

            <h1 className="text-5xl md:text-7xl font-bold mb-6 tracking-tight">
              <span className="text-white">Intelligent Weed Detection</span>
              <br />
              <span className="bg-gradient-to-r from-green-400 via-emerald-400 to-blue-400 bg-clip-text text-transparent">
                for Modern Farming
              </span>
            </h1>

            <p className="text-xl text-slate-400 mb-10 max-w-2xl mx-auto leading-relaxed">
              Transform drone imagery into precision spray coordinates.
              AI-powered detection with sub-meter accuracy for targeted weed control.
            </p>

            <div className="flex gap-4 justify-center items-center">
              <Link href="/auth/signup">
                <Button size="lg" className="bg-gradient-to-r from-green-500 to-emerald-400 text-slate-950 font-semibold hover:from-green-400 hover:to-emerald-300 shadow-xl shadow-green-500/25 px-8 h-12 text-base">
                  Start Free Trial
                  <ArrowRight className="ml-2 w-4 h-4" />
                </Button>
              </Link>
              <Link href="/dashboard">
                <Button size="lg" variant="outline" className="border-slate-700 text-slate-300 hover:bg-white/5 hover:border-slate-600 px-8 h-12 text-base">
                  View Demo
                </Button>
              </Link>
            </div>

            {/* Stats bar */}
            <div className="mt-20 flex justify-center gap-16 text-center">
              <div>
                <div className="text-3xl font-bold text-white">{"<"}1m</div>
                <div className="text-sm text-slate-500 mt-1">GPS Accuracy</div>
              </div>
              <div className="w-px bg-slate-800" />
              <div>
                <div className="text-3xl font-bold text-white">4+</div>
                <div className="text-sm text-slate-500 mt-1">Weed Species</div>
              </div>
              <div className="w-px bg-slate-800" />
              <div>
                <div className="text-3xl font-bold text-white">1000s</div>
                <div className="text-sm text-slate-500 mt-1">Images/Batch</div>
              </div>
            </div>
          </section>

          {/* Features Grid */}
          <section className="pb-24">
            <div className="text-center mb-16">
              <h2 className="text-3xl font-bold text-white mb-4">Complete Detection Pipeline</h2>
              <p className="text-slate-400 max-w-xl mx-auto">
                From drone flight to spray mission file, everything you need in one platform.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-6">
              <Card className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-all duration-300 hover:bg-slate-900/80 group">
                <CardHeader className="pb-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-green-500/20 to-green-500/5 flex items-center justify-center mb-4 group-hover:from-green-500/30 transition-all">
                    <Upload className="w-6 h-6 text-green-400" />
                  </div>
                  <CardTitle className="text-white text-lg">Upload & Extract</CardTitle>
                  <CardDescription className="text-slate-400">
                    Batch upload with automatic EXIF and GPS metadata extraction
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="text-sm text-slate-500 space-y-2">
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-500" />
                      DJI drone metadata support
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-500" />
                      Laser rangefinder integration
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-green-500" />
                      Gimbal angle extraction
                    </li>
                  </ul>
                </CardContent>
              </Card>

              <Card className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-all duration-300 hover:bg-slate-900/80 group">
                <CardHeader className="pb-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500/20 to-blue-500/5 flex items-center justify-center mb-4 group-hover:from-blue-500/30 transition-all">
                    <Zap className="w-6 h-6 text-blue-400" />
                  </div>
                  <CardTitle className="text-white text-lg">AI Detection</CardTitle>
                  <CardDescription className="text-slate-400">
                    AI-powered models for wattle, lantana, and more
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="text-sm text-slate-500 space-y-2">
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-blue-500" />
                      Pre-trained weed models
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-blue-500" />
                      SAM3 manual annotation
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-blue-500" />
                      Custom model training
                    </li>
                  </ul>
                </CardContent>
              </Card>

              <Card className="bg-slate-900/50 border-slate-800 hover:border-slate-700 transition-all duration-300 hover:bg-slate-900/80 group">
                <CardHeader className="pb-4">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500/20 to-emerald-500/5 flex items-center justify-center mb-4 group-hover:from-emerald-500/30 transition-all">
                    <Map className="w-6 h-6 text-emerald-400" />
                  </div>
                  <CardTitle className="text-white text-lg">Geo-Coordinates</CardTitle>
                  <CardDescription className="text-slate-400">
                    Sub-meter precision with terrain-corrected georeferencing
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ul className="text-sm text-slate-500 space-y-2">
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-emerald-500" />
                      DSM terrain correction
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-emerald-500" />
                      Export CSV/KML/Shapefile
                    </li>
                    <li className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-emerald-500" />
                      Spray drone integration
                    </li>
                  </ul>
                </CardContent>
              </Card>
            </div>
          </section>

          {/* Workflow Section */}
          <section className="pb-24">
            <div className="grid lg:grid-cols-2 gap-16 items-center">
              <div className="space-y-8">
                <div>
                  <div className="inline-block px-3 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-400 text-sm font-medium mb-4">
                    End-to-End Workflow
                  </div>
                  <h2 className="text-4xl font-bold text-white mb-4">
                    From Flight to Field
                  </h2>
                  <p className="text-lg text-slate-400">
                    Manage your complete agricultural drone operation. Upload imagery,
                    detect targets, and generate precise spray missions.
                  </p>
                </div>

                <div className="space-y-6">
                  <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                    <div className="w-10 h-10 rounded-lg bg-green-500/10 flex items-center justify-center flex-shrink-0">
                      <Users className="w-5 h-5 text-green-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white mb-1">Team Collaboration</h3>
                      <p className="text-sm text-slate-400">
                        Manage multiple properties, invite team members, and track progress across projects.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                    <div className="w-10 h-10 rounded-lg bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                      <BarChart3 className="w-5 h-5 text-blue-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white mb-1">Historical Analysis</h3>
                      <p className="text-sm text-slate-400">
                        Compare farm data across seasons and track treatment effectiveness over time.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-start gap-4 p-4 rounded-xl bg-slate-900/50 border border-slate-800">
                    <div className="w-10 h-10 rounded-lg bg-emerald-500/10 flex items-center justify-center flex-shrink-0">
                      <Shield className="w-5 h-5 text-emerald-400" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-white mb-1">Chemical Recommendations</h3>
                      <p className="text-sm text-slate-400">
                        Species-specific treatment suggestions with dosage calculations per hectare.
                      </p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Visual placeholder */}
              <div className="relative">
                <div className="aspect-[4/3] rounded-2xl bg-gradient-to-br from-slate-900 to-slate-800 border border-slate-700 overflow-hidden">
                  {/* Map visualization mockup */}
                  <div className="absolute inset-4 rounded-xl bg-slate-950/80 border border-slate-700/50">
                    <div className="absolute inset-0 opacity-30"
                      style={{
                        backgroundImage: `radial-gradient(circle at 30% 40%, rgba(34,197,94,0.3) 0%, transparent 40%),
                                          radial-gradient(circle at 70% 60%, rgba(59,130,246,0.3) 0%, transparent 40%)`
                      }}
                    />
                    {/* Detection points */}
                    <div className="absolute top-1/4 left-1/3 w-3 h-3 rounded-full bg-red-500 animate-ping" />
                    <div className="absolute top-1/4 left-1/3 w-3 h-3 rounded-full bg-red-500" />
                    <div className="absolute top-1/2 left-1/2 w-3 h-3 rounded-full bg-yellow-500 animate-ping animation-delay-300" />
                    <div className="absolute top-1/2 left-1/2 w-3 h-3 rounded-full bg-yellow-500" />
                    <div className="absolute top-2/3 left-1/4 w-3 h-3 rounded-full bg-orange-500 animate-ping animation-delay-500" />
                    <div className="absolute top-2/3 left-1/4 w-3 h-3 rounded-full bg-orange-500" />

                    {/* Center icon */}
                    <div className="absolute inset-0 flex items-center justify-center">
                      <div className="text-center">
                        <Crosshair className="w-16 h-16 text-green-500/40 mx-auto" />
                        <p className="text-xs text-slate-500 mt-2 font-medium">Interactive Detection Map</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Decorative corner accents */}
                <div className="absolute -top-2 -right-2 w-8 h-8 border-t-2 border-r-2 border-green-500/40 rounded-tr-xl" />
                <div className="absolute -bottom-2 -left-2 w-8 h-8 border-b-2 border-l-2 border-blue-500/40 rounded-bl-xl" />
              </div>
            </div>
          </section>

          {/* CTA Section */}
          <section className="pb-24">
            <div className="relative rounded-2xl bg-gradient-to-r from-green-500/10 via-emerald-500/10 to-blue-500/10 border border-slate-800 p-12 text-center overflow-hidden">
              {/* Background glow */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[300px] bg-gradient-to-r from-green-500/20 to-blue-500/20 blur-[80px] rounded-full" />
              </div>

              <div className="relative">
                <h2 className="text-3xl md:text-4xl font-bold text-white mb-4">
                  Ready to Transform Your Operations?
                </h2>
                <p className="text-lg text-slate-400 mb-8 max-w-xl mx-auto">
                  Join Australian farmers using AI-powered detection for precision weed control.
                </p>
                <div className="flex gap-4 justify-center">
                  <Link href="/auth/signup">
                    <Button size="lg" className="bg-gradient-to-r from-green-500 to-emerald-400 text-slate-950 font-semibold hover:from-green-400 hover:to-emerald-300 shadow-xl shadow-green-500/25 px-8">
                      Start Your Free Trial
                    </Button>
                  </Link>
                  <Link href="/dashboard">
                    <Button size="lg" variant="outline" className="border-slate-600 text-slate-300 hover:bg-white/5">
                      Explore Platform
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="border-t border-slate-800">
          <div className="container mx-auto px-6 py-12">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6">
              <div className="flex items-center gap-3">
                <div className="relative w-9 h-9">
                  <div className="absolute inset-0 bg-gradient-to-br from-green-400 to-blue-500 rounded-lg" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Crosshair className="w-5 h-5 text-white" strokeWidth={2.5} />
                  </div>
                </div>
                <div>
                  <span className="text-lg font-bold text-white">National Drones</span>
                  <span className="text-slate-500 mx-2">|</span>
                  <span className="text-slate-400">AgriDrone Ops</span>
                </div>
              </div>

              <p className="text-sm text-slate-500">
                © {new Date().getFullYear()} National Drones Australia. All rights reserved.
              </p>

              <div className="flex gap-6">
                <a href="/privacy" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                  Privacy
                </a>
                <a href="/terms" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                  Terms
                </a>
                <a href="/contact" className="text-sm text-slate-500 hover:text-slate-300 transition-colors">
                  Contact
                </a>
              </div>
            </div>
          </div>
        </footer>
      </div>
    </div>
  );
}
