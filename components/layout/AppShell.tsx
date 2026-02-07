"use client";

import { usePathname } from "next/navigation";
import { Sidebar } from "./Sidebar";

// Pages that should NOT show the sidebar (landing, auth, full-screen views)
const excludedPaths = ["/", "/auth"];

// Pages that use full width (no max-width container)
const fullWidthPaths = ["/map", "/annotate"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  const isExcluded = excludedPaths.some(
    (p) => pathname === p || (p !== "/" && pathname.startsWith(p))
  );

  if (isExcluded) {
    return <>{children}</>;
  }

  const isFullWidth = fullWidthPaths.some((p) => pathname.startsWith(p));

  return (
    <div className="min-h-screen bg-gray-50">
      <Sidebar />
      {/* Main content — offset by sidebar width */}
      <main className={`ml-56 min-h-screen transition-all duration-200 ${isFullWidth ? "" : ""}`}>
        {children}
      </main>
    </div>
  );
}
