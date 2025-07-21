"use client";

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, X, CheckCircle, AlertCircle, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Card } from '@/components/ui/card';

interface UploadedFile {
  id?: string;
  name: string;
  size: number;
  path?: string;
  metadata?: any;
  success?: boolean;
  error?: string;
  progress?: number;
  file?: File;
}

export function ImageUpload() {
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [uploading, setUploading] = useState(false);

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
        
        // Show success message
        alert(`Success! Uploaded ${result.files.filter((f: any) => f.success).length} images. Check console for details.`);
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

  return (
    <div className="space-y-6">
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
              >
                Upload All
              </Button>
            )}
          </div>

          <div className="space-y-3">
            {files.map((file, index) => (
              <div
                key={index}
                className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
              >
                <div className="flex items-center space-x-3 flex-1">
                  <ImageIcon className="w-8 h-8 text-gray-400" />
                  <div className="flex-1">
                    <p className="font-medium text-gray-900">{file.name}</p>
                    <div className="flex items-center space-x-4 text-sm text-gray-500">
                      <span>{formatFileSize(file.size)}</span>
                      {file.metadata && (
                        <>
                          {file.metadata.latitude && (
                            <span>
                              GPS: {file.metadata.latitude.toFixed(6)}, 
                              {file.metadata.longitude.toFixed(6)}
                            </span>
                          )}
                          {file.metadata.altitude && (
                            <span>Alt: {Math.round(file.metadata.altitude)}m</span>
                          )}
                        </>
                      )}
                    </div>
                    {file.progress !== undefined && file.progress < 100 && (
                      <Progress value={file.progress} className="mt-2 h-2" />
                    )}
                  </div>
                </div>

                <div className="flex items-center space-x-2">
                  {file.success && (
                    <CheckCircle className="w-5 h-5 text-green-500" />
                  )}
                  {file.error && (
                    <AlertCircle className="w-5 h-5 text-red-500" />
                  )}
                  {!uploading && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => removeFile(index)}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}