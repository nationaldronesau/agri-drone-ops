import { Suspense } from "react";
import TeachWorkspace from "@/components/teach/TeachWorkspace";

export default function TeachPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-gray-600">Loading teaching workspace…</div>}>
      <TeachWorkspace />
    </Suspense>
  );
}
