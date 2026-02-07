"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, FolderOpen, Camera, MapPin, Calendar, Settings } from "lucide-react";
import Link from "next/link";

interface Project {
  id: string;
  name: string;
  description: string | null;
  location: string | null;
  purpose: string;
  season: string | null;
  createdAt: string;
  cameraProfileId?: string | null;
  cameraProfile?: {
    id: string;
    name: string;
  } | null;
  _count: {
    assets: number;
  };
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [cameraProfiles, setCameraProfiles] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [cameraProfilesError, setCameraProfilesError] = useState<string | null>(null);
  const [updatingProjectId, setUpdatingProjectId] = useState<string | null>(null);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [newProject, setNewProject] = useState({ 
    name: '', 
    description: '', 
    location: '', 
    purpose: 'WEED_DETECTION', 
    season: '' 
  });

  useEffect(() => {
    fetchProjects();
    fetchCameraProfiles();
  }, []);

  const fetchProjects = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data = await response.json();
        setProjects(data.projects || []);
      }
    } catch (error) {
      console.error('Failed to fetch projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchCameraProfiles = async () => {
    try {
      setCameraProfilesError(null);
      const response = await fetch('/api/camera-profiles');
      if (!response.ok) {
        throw new Error('Failed to load camera profiles');
      }
      const data = await response.json();
      setCameraProfiles(
        (data.profiles || []).map((profile: { id: string; name: string }) => ({
          id: profile.id,
          name: profile.name,
        }))
      );
    } catch (error) {
      console.error('Failed to fetch camera profiles:', error);
      setCameraProfilesError(error instanceof Error ? error.message : 'Failed to load camera profiles');
    }
  };

  const createProject = async () => {
    if (!newProject.name.trim()) return;

    try {
      setCreatingProject(true);
      setCreateProjectError(null);
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProject)
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to create project');
      }

      const project = await response.json();
      setProjects((previous) => [project, ...previous]);
      setNewProject({ name: '', description: '', location: '', purpose: 'WEED_DETECTION', season: '' });
      setCreateDialogOpen(false);
    } catch (error) {
      console.error('Failed to create project:', error);
      setCreateProjectError(error instanceof Error ? error.message : 'Failed to create project');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleCreateDialogOpenChange = (open: boolean) => {
    setCreateDialogOpen(open);
    if (!open) {
      setCreateProjectError(null);
      setNewProject({ name: '', description: '', location: '', purpose: 'WEED_DETECTION', season: '' });
    }
  };

  const updateProjectCameraProfile = async (projectId: string, cameraProfileId: string | null) => {
    try {
      setUpdatingProjectId(projectId);
      const response = await fetch(`/api/projects/${projectId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cameraProfileId }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to update camera profile');
      }
      const data = await response.json();
      const updatedProject = data.project;
      setProjects((prev) =>
        prev.map((project) => (project.id === projectId ? updatedProject : project))
      );
    } catch (error) {
      console.error('Failed to update camera profile:', error);
      alert(error instanceof Error ? error.message : 'Failed to update camera profile');
    } finally {
      setUpdatingProjectId(null);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  };

  return (
    <div className="p-6 lg:p-8">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-gray-900 mb-1">Projects</h1>
            <p className="text-sm text-gray-500">
              Organize your drone surveys and analysis into projects
            </p>
          </div>
          <Dialog open={createDialogOpen} onOpenChange={handleCreateDialogOpenChange}>
            <DialogTrigger asChild>
              <Button className="bg-violet-600 hover:bg-violet-700">
                <Plus className="w-4 h-4 mr-2" />
                New Project
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Create New Project</DialogTitle>
                <DialogDescription>
                  Create a new project to organize your drone imagery and analysis results.
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="name">Project Name</Label>
                    <Input
                      id="name"
                      placeholder="e.g., North Field Survey"
                      value={newProject.name}
                      onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                    />
                  </div>
                  <div>
                    <Label htmlFor="location">Farm/Location</Label>
                    <Input
                      id="location"
                      placeholder="e.g., Smiths Farm - North Paddock"
                      value={newProject.location}
                      onChange={(e) => setNewProject({ ...newProject, location: e.target.value })}
                    />
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div>
                    <Label htmlFor="purpose">Survey Purpose</Label>
                    <Select value={newProject.purpose} onValueChange={(value) => setNewProject({ ...newProject, purpose: value })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select purpose" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="WEED_DETECTION">Weed Detection</SelectItem>
                        <SelectItem value="CROP_HEALTH">Crop Health</SelectItem>
                        <SelectItem value="SOIL_ANALYSIS">Soil Analysis</SelectItem>
                        <SelectItem value="INFRASTRUCTURE">Infrastructure</SelectItem>
                        <SelectItem value="LIVESTOCK">Livestock</SelectItem>
                        <SelectItem value="ENVIRONMENTAL">Environmental</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="season">Season/Year</Label>
                    <Input
                      id="season"
                      placeholder="e.g., 2024 Spring, Winter Survey"
                      value={newProject.season}
                      onChange={(e) => setNewProject({ ...newProject, season: e.target.value })}
                    />
                  </div>
                </div>

                <div>
                  <Label htmlFor="description">Description (Optional)</Label>
                  <Input
                    id="description"
                    placeholder="Brief description of the project..."
                    value={newProject.description}
                    onChange={(e) => setNewProject({ ...newProject, description: e.target.value })}
                  />
                </div>

                {createProjectError && (
                  <p className="text-sm text-red-600">{createProjectError}</p>
                )}

                <div className="flex justify-end space-x-2">
                  <Button variant="outline" onClick={() => handleCreateDialogOpenChange(false)} disabled={creatingProject}>
                    Cancel
                  </Button>
                  <Button onClick={createProject} disabled={creatingProject || !newProject.name.trim()}>
                    {creatingProject ? 'Creating...' : 'Create Project'}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {loading ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Loading projects...</p>
          </div>
        ) : projects.length === 0 ? (
          <Card className="text-center py-12">
            <CardContent>
              <FolderOpen className="w-16 h-16 text-gray-400 mx-auto mb-4" />
              <p className="text-gray-500 mb-4">No projects created yet</p>
              <Button
                className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
                onClick={() => {
                  setCreateProjectError(null);
                  setCreateDialogOpen(true);
                }}
              >
                Create Your First Project
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {projects.map((project) => (
              <Card key={project.id} className="hover:shadow-lg transition-shadow cursor-pointer">
                <CardHeader>
                  <div className="flex items-start justify-between">
                    <div className="flex items-center space-x-2">
                      <div className="w-10 h-10 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg flex items-center justify-center">
                        <FolderOpen className="w-5 h-5 text-white" />
                      </div>
                      <div>
                        <CardTitle className="text-lg">{project.name}</CardTitle>
                        {project.description && (
                          <CardDescription className="text-sm">
                            {project.description}
                          </CardDescription>
                        )}
                      </div>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    {project.location && (
                      <div className="text-sm text-gray-600">
                        <MapPin className="w-4 h-4 inline mr-1" />
                        {project.location}
                      </div>
                    )}
                    
                    <div className="flex items-center justify-between text-sm">
                      <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-full text-xs">
                        {project.purpose.replaceAll('_', ' ')}
                      </span>
                      {project.season && (
                        <span className="text-gray-600">{project.season}</span>
                      )}
                    </div>
                    
                    <div className="flex items-center justify-between text-sm">
                      <div className="flex items-center text-gray-600">
                        <Camera className="w-4 h-4 mr-1" />
                        <span>{project._count.assets} images</span>
                      </div>
                      <div className="flex items-center text-gray-600">
                        <Calendar className="w-4 h-4 mr-1" />
                        <span>{formatDate(project.createdAt)}</span>
                      </div>
                    </div>

                    <div className="space-y-1">
                      <Label htmlFor={`cameraProfile-${project.id}`} className="text-xs text-gray-500">
                        Default Camera Profile
                      </Label>
                      <Select
                        value={project.cameraProfileId ?? 'none'}
                        onValueChange={(value) => updateProjectCameraProfile(project.id, value === 'none' ? null : value)}
                        disabled={updatingProjectId === project.id}
                      >
                        <SelectTrigger className="text-sm">
                          <SelectValue placeholder="No default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No default</SelectItem>
                          {cameraProfiles.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>
                              {profile.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {cameraProfilesError && (
                        <p className="text-xs text-red-600">{cameraProfilesError}</p>
                      )}
                    </div>
                    
                    <div className="flex items-center gap-2 pt-2 border-t">
                      <Link href={`/images?project=${project.id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full text-xs">
                          <FolderOpen className="w-3.5 h-3.5 mr-1" />
                          View
                        </Button>
                      </Link>
                      <Link href={`/upload?project=${project.id}`}>
                        <Button variant="outline" size="sm" className="text-xs">
                          <Camera className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                      <Link href={`/projects/${project.id}/settings`}>
                        <Button variant="ghost" size="sm" className="text-xs text-gray-400 hover:text-gray-700">
                          <Settings className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
    </div>
  );
}
