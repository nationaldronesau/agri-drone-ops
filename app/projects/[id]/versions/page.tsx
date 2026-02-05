"use client";

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import DatasetVersions from '@/components/features/dataset-versions';

export default function ProjectVersionsPage() {
  const params = useParams();
  const projectId = params?.id as string | undefined;

  if (!projectId) {
    return <div className="p-6 text-sm text-gray-500">Project not found.</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Link href="/projects">
              <Button variant="ghost" size="sm">
                <ArrowLeft className="w-4 h-4 mr-2" />
                Back to Projects
              </Button>
            </Link>
            <h1 className="text-xl font-semibold text-gray-900">Project Versions</h1>
          </div>
        </div>
      </header>
      <main className="container mx-auto px-4 py-8">
        <DatasetVersions projectId={projectId} />
      </main>
    </div>
  );
}
