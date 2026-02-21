"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import {
  LayoutDashboard,
  FolderOpen,
  Upload,
  Images,
  Map,
  Download,
  Sparkles,
  Brain,
  Activity,
  ClipboardList,
  Mountain,
  Camera,
  ChevronLeft,
  ChevronRight,
  Crosshair,
  Route,
} from "lucide-react";

interface NavItem {
  label: string;
  href: string;
  icon: React.ElementType;
  section?: string;
}

const navItems: NavItem[] = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard, section: "main" },
  { label: "Projects", href: "/projects", icon: FolderOpen, section: "main" },
  { label: "Upload", href: "/upload", icon: Upload, section: "data" },
  { label: "Images", href: "/images", icon: Images, section: "data" },
  { label: "Map", href: "/map", icon: Map, section: "data" },
  { label: "Training Hub", href: "/training-hub", icon: Sparkles, section: "ai" },
  { label: "YOLO Training", href: "/training", icon: Brain, section: "ai" },
  { label: "Temporal Insights", href: "/insights", icon: Activity, section: "ai" },
  { label: "Review Queue", href: "/review-queue", icon: ClipboardList, section: "review" },
  { label: "Mission Planner", href: "/mission-planner", icon: Route, section: "export" },
  { label: "Export", href: "/export", icon: Download, section: "export" },
  { label: "Orthomosaics", href: "/orthomosaics", icon: Mountain, section: "data" },
  { label: "Camera Profiles", href: "/camera-profiles", icon: Camera, section: "settings" },
];

const sectionLabels: Record<string, string> = {
  main: "Overview",
  data: "Data",
  ai: "AI & Training",
  review: "Review",
  export: "Export",
  settings: "Settings",
};

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  const isActive = (href: string) => {
    if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/test-dashboard";
    return pathname.startsWith(href);
  };

  // Group items by section
  const sections = navItems.reduce<Record<string, NavItem[]>>((acc, item) => {
    const section = item.section || "main";
    if (!acc[section]) acc[section] = [];
    acc[section].push(item);
    return acc;
  }, {});

  return (
    <aside
      className={cn(
        "fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-gray-800 bg-gray-950 text-gray-300 transition-all duration-200",
        collapsed ? "w-16" : "w-56"
      )}
    >
      {/* Logo */}
      <div className="flex h-16 items-center border-b border-gray-800 px-4">
        <Link href="/dashboard" className="flex items-center gap-2.5 overflow-hidden">
          <div className="relative flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-green-400 to-blue-500">
            <Crosshair className="h-5 w-5 text-white" strokeWidth={2.5} />
          </div>
          {!collapsed && (
            <div className="flex flex-col overflow-hidden">
              <span className="truncate text-sm font-bold text-white">
                National Drones
              </span>
              <span className="truncate text-[10px] uppercase tracking-widest text-green-400/80">
                AgriDrone Ops
              </span>
            </div>
          )}
        </Link>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-2 py-4">
        {Object.entries(sections).map(([sectionKey, items]) => (
          <div key={sectionKey} className="mb-4">
            {!collapsed && (
              <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                {sectionLabels[sectionKey]}
              </p>
            )}
            {items.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "group mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    active
                      ? "bg-violet-600/20 text-violet-400"
                      : "text-gray-400 hover:bg-gray-800/60 hover:text-white"
                  )}
                  title={collapsed ? item.label : undefined}
                >
                  <Icon
                    className={cn(
                      "h-4.5 w-4.5 flex-shrink-0",
                      active ? "text-violet-400" : "text-gray-500 group-hover:text-gray-300"
                    )}
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {active && !collapsed && (
                    <span className="ml-auto h-1.5 w-1.5 rounded-full bg-violet-400" />
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Collapse Toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex h-12 items-center justify-center border-t border-gray-800 text-gray-500 transition-colors hover:bg-gray-800/60 hover:text-white"
      >
        {collapsed ? (
          <ChevronRight className="h-4 w-4" />
        ) : (
          <ChevronLeft className="h-4 w-4" />
        )}
      </button>
    </aside>
  );
}
