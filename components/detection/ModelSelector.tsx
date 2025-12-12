'use client';

import { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { RefreshCw, Zap, AlertCircle } from 'lucide-react';

export interface RoboflowModel {
  id: string;
  projectId: string;
  projectName: string;
  version: number;
  type: string;
  endpoint: string;
  classes: string[];
  map?: number;
  createdAt: string;
}

interface ModelSelectorProps {
  selectedModels: string[];
  onSelectionChange: (modelIds: string[]) => void;
  disabled?: boolean;
}

// Color palette for different models
const MODEL_COLORS = [
  '#22c55e', // green
  '#3b82f6', // blue
  '#f97316', // orange
  '#ec4899', // pink
  '#8b5cf6', // purple
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
];

export function ModelSelector({
  selectedModels,
  onSelectionChange,
  disabled = false,
}: ModelSelectorProps) {
  const [models, setModels] = useState<RoboflowModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const fetchModels = async () => {
    try {
      setSyncing(true);
      setError(null);

      const response = await fetch('/api/roboflow/models');
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch models');
      }

      setModels(data.models || []);

      // Auto-select first model if none selected and models available
      if (data.models?.length > 0 && selectedModels.length === 0) {
        onSelectionChange([data.models[0].id]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load models');
    } finally {
      setLoading(false);
      setSyncing(false);
    }
  };

  useEffect(() => {
    fetchModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleModel = (modelId: string) => {
    if (selectedModels.includes(modelId)) {
      onSelectionChange(selectedModels.filter((id) => id !== modelId));
    } else {
      onSelectionChange([...selectedModels, modelId]);
    }
  };

  const selectAll = () => {
    onSelectionChange(models.map((m) => m.id));
  };

  const selectNone = () => {
    onSelectionChange([]);
  };

  if (loading) {
    return (
      <div className="border rounded-lg p-4 bg-gray-50">
        <div className="flex items-center gap-2 text-gray-500">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span>Loading detection models...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="border rounded-lg p-4 bg-red-50 border-red-200">
        <div className="flex items-center gap-2 text-red-600 mb-2">
          <AlertCircle className="w-4 h-4" />
          <span className="font-medium">Failed to load models</span>
        </div>
        <p className="text-sm text-red-500 mb-3">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={fetchModels}
          disabled={syncing}
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${syncing ? 'animate-spin' : ''}`} />
          Retry
        </Button>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="border rounded-lg p-4 bg-amber-50 border-amber-200">
        <div className="flex items-center gap-2 text-amber-700 mb-2">
          <AlertCircle className="w-4 h-4" />
          <span className="font-medium">No deployed models found</span>
        </div>
        <p className="text-sm text-amber-600">
          Train and deploy a model to use it for detection.
        </p>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-blue-600" />
          <h3 className="font-medium text-gray-900">AI Detection Models</h3>
          <span className="text-xs text-gray-500">({models.length} available)</span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={selectAll}
            disabled={disabled}
            className="text-xs"
          >
            Select All
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={selectNone}
            disabled={disabled}
            className="text-xs"
          >
            Clear
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={fetchModels}
            disabled={syncing || disabled}
            title="Refresh models"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        {models.map((model, index) => {
          const color = MODEL_COLORS[index % MODEL_COLORS.length];
          const isSelected = selectedModels.includes(model.id);

          return (
            <label
              key={model.id}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                isSelected
                  ? 'border-blue-300 bg-blue-50'
                  : 'border-gray-200 hover:border-gray-300 hover:bg-gray-50'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              <Checkbox
                checked={isSelected}
                onCheckedChange={() => toggleModel(model.id)}
                disabled={disabled}
                className="mt-0.5"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span className="font-medium text-gray-900 truncate">
                    {model.projectName}
                  </span>
                  <span className="text-xs text-gray-500">v{model.version}</span>
                  {model.map && (
                    <span className="text-xs text-green-600 bg-green-50 px-1.5 py-0.5 rounded">
                      {(model.map * 100).toFixed(1)}% mAP
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {model.classes.slice(0, 5).map((cls) => (
                    <span
                      key={cls}
                      className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
                    >
                      {cls}
                    </span>
                  ))}
                  {model.classes.length > 5 && (
                    <span className="text-xs text-gray-400">
                      +{model.classes.length - 5} more
                    </span>
                  )}
                </div>
              </div>
            </label>
          );
        })}
      </div>

      {selectedModels.length > 0 && (
        <div className="mt-4 pt-3 border-t text-sm text-gray-600">
          <span className="font-medium">{selectedModels.length}</span> model
          {selectedModels.length !== 1 ? 's' : ''} selected for detection
        </div>
      )}
    </div>
  );
}

// Export helper to get model details by ID
export function getModelColor(index: number): string {
  return MODEL_COLORS[index % MODEL_COLORS.length];
}
