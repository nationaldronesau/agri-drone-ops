"use client";

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { ArrowLeft, Plus, FolderOpen, Camera, MapPin, Calendar } from "lucide-react";
import Link from "next/link";

interface Project {
  id: string;
  name: string;
  description: string | null;
  location: string | null;
  purpose: string;
  season: string | null;
  createdAt: string;
  _count: {
    assets: number;
  };
}

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [newProject, setNewProject] = useState({ 
    name: '', 
    description: '', 
    location: '', 
    purpose: 'WEED_DETECTION', 
    season: '' 
  });

  useEffect(() => {
    fetchProjects();
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

  const createProject = async () => {
    if (!newProject.name.trim()) return;

    try {
      const response = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newProject)
      });

      if (response.ok) {
        const project = await response.json();
        setProjects([project, ...projects]);
        setNewProject({ name: '', description: '', location: '', purpose: 'WEED_DETECTION', season: '' });
        setCreateDialogOpen(false);
      }
    } catch (error) {
      console.error('Failed to create project:', error);
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
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-4">
              <Link href="/test-dashboard">
                <Button variant="ghost" size="sm">
                  <ArrowLeft className="w-4 h-4 mr-2" />
                  Back to Dashboard
                </Button>
              </Link>
              <div className="flex items-center space-x-2">
                <div className="w-8 h-8 bg-gradient-to-r from-green-500 to-blue-500 rounded-lg"></div>
                <span className="text-xl font-bold bg-gradient-to-r from-green-600 to-blue-600 bg-clip-text text-transparent">
                  AgriDrone Ops
                </span>
              </div>
            </div>
            <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
              <DialogTrigger asChild>
                <Button className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
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
                      <select
                        id="purpose"
                        value={newProject.purpose}
                        onChange={(e) => setNewProject({ ...newProject, purpose: e.target.value })}
                        className="w-full mt-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
                      >
                        <option value="WEED_DETECTION">Weed Detection</option>
                        <option value="CROP_HEALTH">Crop Health</option>
                        <option value="SOIL_ANALYSIS">Soil Analysis</option>
                        <option value="INFRASTRUCTURE">Infrastructure</option>
                        <option value="LIVESTOCK">Livestock</option>
                        <option value="ENVIRONMENTAL">Environmental</option>
                      </select>
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
                  
                  <div className="flex justify-end space-x-2">
                    <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                      Cancel
                    </Button>
                    <Button onClick={createProject} disabled={!newProject.name.trim()}>
                      Create Project
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="mb-6">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">Projects</h1>
          <p className="text-gray-600">
            Organize your drone surveys and analysis into projects
          </p>
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
              <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
                <DialogTrigger asChild>
                  <Button className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600">
                    Create Your First Project
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
                    <div>
                      <Label htmlFor="name">Project Name</Label>
                      <Input
                        id="name"
                        placeholder="e.g., North Field Survey 2024"
                        value={newProject.name}
                        onChange={(e) => setNewProject({ ...newProject, name: e.target.value })}
                      />
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
                    <div className="flex justify-end space-x-2">
                      <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={createProject} disabled={!newProject.name.trim()}>
                        Create Project
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
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
                        {project.purpose.replace('_', ' ')}
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
                    
                    <div className="flex space-x-2">
                      <Link href={`/upload?project=${project.id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full">
                          <Camera className="w-4 h-4 mr-1" />
                          Upload
                        </Button>
                      </Link>
                      <Link href={`/images?project=${project.id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full">
                          <FolderOpen className="w-4 h-4 mr-1" />
                          View
                        </Button>
                      </Link>
                      <Link href={`/map?project=${project.id}`} className="flex-1">
                        <Button variant="outline" size="sm" className="w-full">
                          <MapPin className="w-4 h-4 mr-1" />
                          Map
                        </Button>
                      </Link>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}