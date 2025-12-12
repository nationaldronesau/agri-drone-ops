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
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Plus, RefreshCw, Loader2 } from 'lucide-react';

interface RoboflowClass {
  id: string;
  className: string;
  count: number;
  color: string | null;
}

interface ClassSelectorProps {
  projectId: string;
  value?: string;
  onChange: (className: string, classData: RoboflowClass | null) => void;
  disabled?: boolean;
  placeholder?: string;
  showAddButton?: boolean;
}

export function ClassSelector({
  projectId,
  value,
  onChange,
  disabled = false,
  placeholder = 'Select a class',
  showAddButton = true,
}: ClassSelectorProps) {
  const [classes, setClasses] = useState<RoboflowClass[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [newClassName, setNewClassName] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const fetchClasses = async (sync = false) => {
    if (!projectId) {
      setClasses([]);
      setLoading(false);
      return;
    }

    try {
      if (sync) setSyncing(true);
      else setLoading(true);
      setError(null);

      const response = await fetch(
        `/api/roboflow/projects/${projectId}/classes${sync ? '?sync=true' : ''}`
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch classes');
      }

      setClasses(data.classes || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load classes');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchClasses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const handleValueChange = (className: string) => {
    const selectedClass = classes.find((c) => c.className === className) || null;
    onChange(className, selectedClass);
  };

  const handleAddClass = async () => {
    if (!newClassName.trim()) {
      setAddError('Class name is required');
      return;
    }

    try {
      setAdding(true);
      setAddError(null);

      const response = await fetch(`/api/roboflow/projects/${projectId}/classes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ className: newClassName.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to add class');
      }

      // Add new class to list and select it
      setClasses((prev) => [...prev, data]);
      onChange(data.className, data);
      setNewClassName('');
      setShowAddDialog(false);
    } catch (err) {
      setAddError(err instanceof Error ? err.message : 'Failed to add class');
    } finally {
      setAdding(false);
    }
  };

  const handleCloseAddDialog = () => {
    if (!adding) {
      setNewClassName('');
      setAddError(null);
      setShowAddDialog(false);
    }
  };

  if (!projectId) {
    return (
      <Select disabled>
        <SelectTrigger>
          <SelectValue placeholder="Select a project first" />
        </SelectTrigger>
      </Select>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2">
        <div className="flex-1 h-10 bg-gray-100 rounded-md animate-pulse" />
        {showAddButton && <div className="w-10 h-10 bg-gray-100 rounded-md animate-pulse" />}
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
          onClick={() => fetchClasses()}
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
              {value && (
                <div className="flex items-center gap-2">
                  {classes.find((c) => c.className === value)?.color && (
                    <div
                      className="w-3 h-3 rounded-full"
                      style={{
                        backgroundColor:
                          classes.find((c) => c.className === value)?.color || undefined,
                      }}
                    />
                  )}
                  <span>{value}</span>
                </div>
              )}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {classes.length === 0 ? (
              <div className="py-4 px-3 text-center text-sm text-gray-500">
                No classes defined yet
              </div>
            ) : (
              classes.map((cls) => (
                <SelectItem key={cls.id} value={cls.className}>
                  <div className="flex items-center gap-2">
                    {cls.color && (
                      <div
                        className="w-3 h-3 rounded-full"
                        style={{ backgroundColor: cls.color }}
                      />
                    )}
                    <span>{cls.className}</span>
                    <span className="text-xs text-gray-400">({cls.count})</span>
                  </div>
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="icon"
          onClick={() => fetchClasses(true)}
          disabled={syncing}
          title="Sync classes from training project"
        >
          <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
        </Button>

        {showAddButton && (
          <Button
            variant="outline"
            size="icon"
            onClick={() => setShowAddDialog(true)}
            title="Add new class"
          >
            <Plus className="w-4 h-4" />
          </Button>
        )}
      </div>

      <Dialog open={showAddDialog} onOpenChange={handleCloseAddDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add New Class</DialogTitle>
            <DialogDescription>
              Add a new class to this project. The class will be created locally and synced
              when you upload annotations for training.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Input
                value={newClassName}
                onChange={(e) => setNewClassName(e.target.value)}
                placeholder="e.g., lantana, wattle, unknown-weed"
                disabled={adding}
              />
              <p className="text-xs text-gray-500">
                Use lowercase letters, numbers, and hyphens only.
              </p>
            </div>

            {addError && (
              <div className="p-3 rounded-md bg-red-50 text-red-700 text-sm">{addError}</div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={handleCloseAddDialog} disabled={adding}>
              Cancel
            </Button>
            <Button onClick={handleAddClass} disabled={adding || !newClassName.trim()}>
              {adding ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Adding...
                </>
              ) : (
                'Add Class'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
