'use client';

import { useState, useEffect } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Plus, RefreshCw, Database } from 'lucide-react';
import { CreateProjectDialog } from './CreateProjectDialog';

interface RoboflowProject {
  project: {
    id: string;
    roboflowId: string;
    name: string;
    type: string;
    imageCount: number;
  };
  classes: Array<{
    id: string;
    className: string;
    count: number;
    color: string | null;
  }>;
}

interface RoboflowProjectSelectorProps {
  value?: string;
  onChange: (projectId: string, project: RoboflowProject | null) => void;
  disabled?: boolean;
  placeholder?: string;
  showCreateButton?: boolean;
}

export function RoboflowProjectSelector({
  value,
  onChange,
  disabled = false,
  placeholder = 'Select a Roboflow project',
  showCreateButton = true,
}: RoboflowProjectSelectorProps) {
  const [projects, setProjects] = useState<RoboflowProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);

  const fetchProjects = async (sync = false) => {
    try {
      if (sync) setSyncing(true);
      else setLoading(true);
      setError(null);

      const response = await fetch(`/api/roboflow/projects${sync ? '?sync=true' : ''}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch projects');
      }

      setProjects(data.projects || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleValueChange = (projectId: string) => {
    const selectedProject = projects.find((p) => p.project.id === projectId) || null;
    onChange(projectId, selectedProject);
  };

  const handleProjectCreated = () => {
    setShowCreateDialog(false);
    fetchProjects(true);
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-10 bg-gray-100 rounded-md animate-pulse" />
        {showCreateButton && <div className="w-10 h-10 bg-gray-100 rounded-md animate-pulse" />}
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 p-2 text-sm text-red-600 bg-red-50 rounded-md">
          {error}
        </div>
        <Button
          variant="outline"
          size="icon"
          onClick={() => fetchProjects()}
          title="Retry"
        >
          <RefreshCw className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Select
          value={value}
          onValueChange={handleValueChange}
          disabled={disabled || syncing}
        >
          <SelectTrigger className="flex-1">
            <SelectValue placeholder={placeholder}>
              {value && projects.find((p) => p.project.id === value)?.project.name}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {projects.length === 0 ? (
              <div className="py-6 px-4 text-center text-sm text-gray-500">
                <Database className="w-8 h-8 mx-auto mb-2 text-gray-300" />
                No projects found
              </div>
            ) : (
              projects.map((item) => (
                <SelectItem key={item.project.id} value={item.project.id}>
                  <div className="flex items-center gap-2">
                    <span>{item.project.name}</span>
                    <span className="text-xs text-gray-400">
                      ({item.project.imageCount} images)
                    </span>
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="icon"
          onClick={() => fetchProjects(true)}
          disabled={syncing}
          title="Sync training projects"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
        </Button>

        {showCreateButton && (
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowCreateDialog(true)}
            title="Create new project"
          >
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onSuccess={handleProjectCreated}
      />
    </>
  );
}
