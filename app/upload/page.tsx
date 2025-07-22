"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Upload, X, CheckCircle, AlertCircle, Brain, Image as ImageIcon } from "lucide-react";
import Link from "next/link";
import { useDropzone } from 'react-dropzone';
import { Progress } from '@/components/ui/progress';
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { ROBOFLOW_MODELS } from "@/lib/services/roboflow";

interface Project {
  id: string;
  name: string;
  location: string | null;
  purpose: string;
}

interface UploadedFile {
  id?: string;
  name: string;
  size: number;
  path?: string;
  metadata?: any;
  detections?: any[];
  success?: boolean;
  error?: string;
  warning?: string;
  progress?: number;
  file?: File;
}

export default function UploadPage() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string>("");
  const [runDetection, setRunDetection] = useState(true);
  const [selectedModels, setSelectedModels] = useState<string[]>(() => 
    Object.keys(ROBOFLOW_MODELS).filter(key => !ROBOFLOW_MODELS[key as keyof typeof ROBOFLOW_MODELS].disabled)
  );
  
  // Fetch projects on mount
  useEffect(() => {
    fetch('/api/projects')
      .then(res => res.json())
      .then(data => {
        setProjects(data);
        if (data.length > 0) {
          setSelectedProject(data[0].id);
        }
      })
      .catch(console.error);
  }, []);
  
  const onDrop = useCallback((acceptedFiles: File[]) => {
    const newFiles = acceptedFiles.map(file => ({
      name: file.name,
      size: file.size,
      file: file,
      progress: 0
    }));
    setFiles(prev => [...prev, ...newFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png', '.tiff', '.tif']
    },
    multiple: true
  });
  
  const uploadFiles = async () => {
    setUploading(true);
    
    const formData = new FormData();
    files.forEach(file => {
      if (file.file) {
        formData.append('files', file.file);
      }
    });
    
    // Add project and detection settings
    formData.append('projectId', selectedProject);
    formData.append('runDetection', runDetection.toString());
    formData.append('detectionModels', selectedModels.join(','));

    try {
      // Show progress immediately
      setFiles(prevFiles => 
        prevFiles.map(file => ({
          ...file,
          progress: 50
        }))
      );

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      const result = await response.json();
      console.log('Upload response:', result);
      
      if (response.ok) {
        // Update files with results
        setFiles(prevFiles => 
          prevFiles.map(file => {
            const uploadedFile = result.files.find((f: any) => f.name === file.name);
            if (uploadedFile) {
              return {
                ...file,
                ...uploadedFile,
                progress: 100
              };
            }
            return file;
          })
        );
        
        // Show success message with detection results
        const successCount = result.files.filter((f: any) => f.success).length;
        const detectionCount = result.files.reduce((acc: number, f: any) => 
          acc + (f.detections?.length || 0), 0);
        
        if (detectionCount > 0) {
          alert(`Success! Uploaded ${successCount} images with ${detectionCount} weeds detected.`);
        } else {
          alert(`Success! Uploaded ${successCount} images.`);
        }
      } else {
        console.error('Upload failed:', result.error);
        alert('Upload failed: ' + (result.error || 'Unknown error'));
      }
    } catch (error) {
      console.error('Upload error:', error);
      alert('Upload error: ' + error);
    } finally {
      setUploading(false);
    }
  };

  const removeFile = (index: number) => {
    setFiles(files.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1048576) return Math.round(bytes / 1024) + ' KB';
    return Math.round(bytes / 1048576) + ' MB';
  };
  
  const toggleModel = (model: string) => {
    setSelectedModels(prev => 
      prev.includes(model) 
        ? prev.filter(m => m !== model)
        : [...prev, model]
    );
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
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto px-4 py-8">
        <div className="max-w-4xl mx-auto space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">Upload Drone Images</CardTitle>
              <CardDescription>
                Upload your drone imagery for AI-powered weed detection and georeferencing. 
                Images should contain GPS metadata for accurate coordinate conversion.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Project Selection */}
              <div className="space-y-2">
                <Label htmlFor="project">Select Project</Label>
                <Select value={selectedProject} onValueChange={setSelectedProject}>
                  <SelectTrigger id="project">
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map(project => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name} {project.location && `- ${project.location}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              
              {/* AI Detection Settings */}
              <div className="space-y-4 p-4 bg-green-50 rounded-lg border border-green-200">
                <div className="flex items-center space-x-2">
                  <Checkbox 
                    id="runDetection" 
                    checked={runDetection}
                    onCheckedChange={(checked) => setRunDetection(checked as boolean)}
                  />
                  <Label htmlFor="runDetection" className="flex items-center cursor-pointer">
                    <Brain className="w-4 h-4 mr-2 text-green-600" />
                    Run AI weed detection after upload
                  </Label>
                </div>
                
                {runDetection && (
                  <div className="space-y-2 ml-6">
                    <Label className="text-sm text-gray-600">Select weed detection models:</Label>
                    <div className="grid grid-cols-2 gap-2">
                      {Object.entries(ROBOFLOW_MODELS).map(([key, model]) => (
                        <div key={key} className={`flex items-center space-x-2 ${model.disabled ? 'opacity-50' : ''}`}>
                          <Checkbox 
                            id={key}
                            checked={selectedModels.includes(key)}
                            onCheckedChange={() => toggleModel(key)}
                            disabled={model.disabled}
                          />
                          <Label 
                            htmlFor={key} 
                            className={`text-sm flex items-center ${model.disabled ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                          >
                            <div 
                              className="w-3 h-3 rounded-full mr-2" 
                              style={{ backgroundColor: model.color }}
                            />
                            {model.name}
                            {model.disabled && (
                              <span className="text-xs text-gray-400 ml-1">(Coming Soon)</span>
                            )}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
              
              {/* Dropzone */}
              <div
                {...getRootProps()}
                className={`
                  border-2 border-dashed rounded-lg p-8 text-center cursor-pointer
                  transition-colors duration-200
                  ${isDragActive 
                    ? 'border-green-500 bg-green-50' 
                    : 'border-gray-300 hover:border-green-400 hover:bg-gray-50'
                  }
                `}
              >
                <input {...getInputProps()} />
                <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400" />
                {isDragActive ? (
                  <p className="text-lg text-green-600">Drop the images here...</p>
                ) : (
                  <>
                    <p className="text-lg text-gray-600 mb-2">
                      Drag & drop drone images here, or click to select
                    </p>
                    <p className="text-sm text-gray-500">
                      Supports JPEG, PNG, TIFF formats • Multiple files allowed
                    </p>
                  </>
                )}
              </div>
              
              {/* File list */}
              {files.length > 0 && (
                <Card className="p-6">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-lg font-semibold">
                      {files.length} file{files.length > 1 ? 's' : ''} selected
                    </h3>
                    {files.length > 0 && !uploading && (
                      <Button 
                        onClick={uploadFiles}
                        className="bg-gradient-to-r from-green-500 to-blue-500 hover:from-green-600 hover:to-blue-600"
                        disabled={!selectedProject}
                      >
                        <Upload className="w-4 h-4 mr-2" />
                        Upload All
                      </Button>
                    )}
                  </div>
                  
                  <div className="space-y-3">
                    {files.map((file, index) => (
                      <div key={index} className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
                        <ImageIcon className="w-8 h-8 text-gray-400" />
                        <div className="flex-1">
                          <p className="font-medium text-sm">{file.name}</p>
                          <p className="text-xs text-gray-500">{formatFileSize(file.size)}</p>
                          {file.detections && file.detections.length > 0 && (
                            <p className="text-xs text-green-600 mt-1">
                              {file.detections.length} weeds detected
                            </p>
                          )}
                          {file.warning && (
                            <p className="text-xs text-yellow-600 mt-1">{file.warning}</p>
                          )}
                        </div>
                        {file.progress !== undefined && file.progress < 100 && (
                          <div className="w-32">
                            <Progress value={file.progress} className="h-2" />
                          </div>
                        )}
                        {file.success && (
                          <CheckCircle className="w-5 h-5 text-green-500" />
                        )}
                        {file.error && (
                          <AlertCircle className="w-5 h-5 text-red-500" />
                        )}
                        {!uploading && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => removeFile(index)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}
              
              <div className="mt-8 p-4 bg-blue-50 rounded-lg border border-blue-200">
                <h4 className="font-semibold text-blue-900 mb-2">Pro Tips:</h4>
                <ul className="space-y-1 text-sm text-blue-800">
                  <li>• Ensure your drone captures GPS metadata in images</li>
                  <li>• For best results, maintain consistent altitude during flight</li>
                  <li>• AI detection works best with clear, well-lit images</li>
                  <li>• Detection results will be automatically georeferenced</li>
                  <li>• You can upload multiple images at once for batch processing</li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}