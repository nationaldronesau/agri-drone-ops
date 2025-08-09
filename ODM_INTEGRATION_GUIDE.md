# OpenDroneMap Integration Guide for Desktop App

## 🎯 Overview

OpenDroneMap (ODM) is an open-source toolkit for processing aerial drone imagery. It can create:
- **Orthomosaics** (georeferenced aerial maps)
- **3D Models** (point clouds and textured meshes)
- **Digital Surface Models** (DSM)
- **Digital Terrain Models** (DTM)

## 🚀 Integration Options

### Option 1: Docker-based ODM (Recommended)

**Pros:**
- Easy installation
- Consistent environment
- GPU support available
- No dependency conflicts

**Implementation:**

```javascript
// electron/services/odm-docker.js
const Docker = require('dockerode');
const fs = require('fs-extra');
const path = require('path');

class ODMProcessor {
  constructor() {
    this.docker = new Docker();
  }

  async processProject(projectPath, options = {}) {
    const defaultOptions = {
      'dsm': true,
      'dtm': true,
      'orthophoto-resolution': 5,  // cm/pixel
      'min-num-features': 8000,
      'matcher-neighbors': 8,
      'use-3dmesh': true,
      'use-opensfm-dense': true,
      'feature-quality': 'high'
    };

    const mergedOptions = { ...defaultOptions, ...options };
    
    // Build command arguments
    const args = Object.entries(mergedOptions)
      .map(([key, value]) => `--${key} ${value}`)
      .join(' ');

    // Create container
    const container = await this.docker.createContainer({
      Image: 'opendronemap/odm:latest',
      Cmd: args.split(' '),
      HostConfig: {
        Binds: [`${projectPath}:/datasets`],
        // Optional: GPU support
        DeviceRequests: [{
          Count: -1,
          Capabilities: [['gpu']]
        }]
      }
    });

    // Start processing
    await container.start();
    
    // Stream logs
    const stream = await container.attach({ 
      stream: true, 
      stdout: true, 
      stderr: true 
    });
    
    return new Promise((resolve, reject) => {
      stream.on('data', (data) => {
        const message = data.toString();
        console.log(message);
        
        // Parse progress
        const progress = this.parseProgress(message);
        if (progress) {
          this.emit('progress', progress);
        }
      });
      
      stream.on('end', async () => {
        await container.remove();
        resolve(this.getResults(projectPath));
      });
    });
  }

  parseProgress(message) {
    // ODM outputs progress like "[INFO] Running SMVS stage"
    const stageMatch = message.match(/Running (\w+) stage/);
    if (stageMatch) {
      const stages = [
        'dataset', 'opensfm', 'openmvs', 'odm_filterpoints',
        'odm_meshing', 'mvs_texturing', 'odm_georeferencing',
        'odm_orthophoto', 'odm_report'
      ];
      const currentStage = stageMatch[1];
      const stageIndex = stages.indexOf(currentStage.toLowerCase());
      
      if (stageIndex !== -1) {
        return {
          stage: currentStage,
          progress: (stageIndex + 1) / stages.length * 100
        };
      }
    }
    return null;
  }

  getResults(projectPath) {
    const outputDir = path.join(projectPath, 'odm_orthophoto');
    return {
      orthophoto: path.join(outputDir, 'odm_orthophoto.tif'),
      dsm: path.join(projectPath, 'odm_dem', 'dsm.tif'),
      dtm: path.join(projectPath, 'odm_dem', 'dtm.tif'),
      pointCloud: path.join(projectPath, 'odm_georeferencing', 'odm_georeferenced_model.laz'),
      report: path.join(projectPath, 'odm_report', 'report.pdf')
    };
  }
}
```

### Option 2: WebODM API Integration

**Pros:**
- Nice web interface
- Task management
- Multi-user support
- Processing queue

**Implementation:**

```javascript
// electron/services/webodm-client.js
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs-extra');

class WebODMClient {
  constructor(url = 'http://localhost:8000', token = null) {
    this.baseURL = url;
    this.token = token;
    this.client = axios.create({
      baseURL: url,
      headers: token ? { 'Authorization': `JWT ${token}` } : {}
    });
  }

  async authenticate(username, password) {
    const response = await this.client.post('/api/token-auth/', {
      username,
      password
    });
    this.token = response.data.token;
    this.client.defaults.headers['Authorization'] = `JWT ${this.token}`;
    return this.token;
  }

  async createProject(name, description = '') {
    const response = await this.client.post('/api/projects/', {
      name,
      description
    });
    return response.data;
  }

  async createTask(projectId, images, options = {}) {
    const formData = new FormData();
    
    // Add images
    for (const imagePath of images) {
      formData.append('images', fs.createReadStream(imagePath));
    }
    
    // Add processing options
    const defaultOptions = {
      'dsm': true,
      'dtm': true,
      'auto_boundary': true,
      'use_3dmesh': true,
      'orthophoto_resolution': 5
    };
    
    formData.append('options', JSON.stringify({
      ...defaultOptions,
      ...options
    }));

    const response = await this.client.post(
      `/api/projects/${projectId}/tasks/`,
      formData,
      {
        headers: formData.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      }
    );

    return response.data;
  }

  async getTaskStatus(taskId) {
    const response = await this.client.get(`/api/projects/tasks/${taskId}/`);
    return response.data;
  }

  async downloadResults(taskId, outputDir) {
    const assets = [
      { name: 'orthophoto.tif', url: `/api/projects/tasks/${taskId}/download/orthophoto.tif` },
      { name: 'dsm.tif', url: `/api/projects/tasks/${taskId}/download/dsm.tif` },
      { name: 'dtm.tif', url: `/api/projects/tasks/${taskId}/download/dtm.tif` },
      { name: 'all.zip', url: `/api/projects/tasks/${taskId}/download/all.zip` }
    ];

    for (const asset of assets) {
      try {
        const response = await this.client.get(asset.url, {
          responseType: 'stream'
        });
        
        const outputPath = path.join(outputDir, asset.name);
        const writer = fs.createWriteStream(outputPath);
        
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
          writer.on('finish', resolve);
          writer.on('error', reject);
        });
      } catch (error) {
        console.error(`Failed to download ${asset.name}:`, error.message);
      }
    }
  }
}
```

### Option 3: NodeODM (Lightweight API)

**Pros:**
- Lightweight
- REST API
- No database required
- Easy to embed

**Installation:**
```bash
docker run -p 3000:3000 opendronemap/nodeodm
```

**Implementation:**

```javascript
// electron/services/nodeodm-client.js
const NodeODM = require('node-odm');

class NodeODMClient {
  constructor(host = 'localhost', port = 3000) {
    this.node = new NodeODM.Node(host, port);
  }

  async processImages(images, options = {}) {
    return new Promise((resolve, reject) => {
      this.node.create({
        images,
        options
      }, (err, task) => {
        if (err) {
          reject(err);
          return;
        }

        console.log('Task created:', task.uuid);

        // Monitor progress
        let lastProgress = 0;
        const progressInterval = setInterval(() => {
          task.info((err, info) => {
            if (err) return;
            
            if (info.progress !== lastProgress) {
              lastProgress = info.progress;
              console.log(`Progress: ${info.progress}%`);
              this.emit('progress', info.progress);
            }

            if (info.status.code === NodeODM.TaskStatus.COMPLETED) {
              clearInterval(progressInterval);
              
              // Download results
              task.downloadAssets('.', (err, assets) => {
                if (err) reject(err);
                else resolve(assets);
              });
            } else if (info.status.code === NodeODM.TaskStatus.FAILED) {
              clearInterval(progressInterval);
              reject(new Error(info.status.errorMessage));
            }
          });
        }, 1000);

        // Start processing
        task.start();
      });
    });
  }
}
```

## 🎛️ Processing Options

### Key ODM Parameters:

```javascript
const processingOptions = {
  // Quality vs Speed
  'feature-quality': 'ultra',     // ultra, high, medium, low, lowest
  'pc-quality': 'high',          // ultra, high, medium, low, lowest
  
  // Resolution
  'orthophoto-resolution': 2.5,   // cm/pixel (lower = higher quality)
  'dem-resolution': 5,           // cm/pixel for elevation models
  
  // Outputs
  'dsm': true,                   // Digital Surface Model
  'dtm': true,                   // Digital Terrain Model
  'use-3dmesh': true,            // 3D textured mesh
  
  // Advanced
  'matcher-neighbors': 16,        // More = better matching, slower
  'min-num-features': 10000,      // More = better quality, slower
  'use-opensfm-dense': true,      // Better point cloud
  'pc-las': true,                // Export LAS point cloud
  
  // Performance
  'max-memory': 16000,           // MB of RAM to use
  'use-gpu': true,               // Enable GPU acceleration
  
  // Special cases
  'fast-orthophoto': false,      // Quick preview mode
  'crop': 0,                     // Crop border (meters)
  'auto-boundary': true          // Auto-detect survey area
};
```

## 🖥️ Desktop UI Integration

```tsx
// components/orthomosaic-processor.tsx
import { useState } from 'react';
import { Progress } from '@/components/ui/progress';

export function OrthomosaicProcessor({ projectId, images }) {
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');

  const startProcessing = async () => {
    setProcessing(true);
    
    try {
      const result = await window.electronAPI.processOrthomosaic({
        projectId,
        images,
        options: {
          'orthophoto-resolution': 2.5,
          'dsm': true,
          'feature-quality': 'high'
        }
      });

      // Handle results
      console.log('Processing complete:', result);
    } catch (error) {
      console.error('Processing failed:', error);
    } finally {
      setProcessing(false);
    }
  };

  // Listen for progress updates
  useEffect(() => {
    const unsubscribe = window.electronAPI.onProcessingProgress((data) => {
      setProgress(data.progress);
      setStage(data.stage);
    });

    return unsubscribe;
  }, []);

  return (
    <div className="p-6 bg-white rounded-lg shadow">
      <h3 className="text-lg font-semibold mb-4">Orthomosaic Processing</h3>
      
      {!processing ? (
        <button
          onClick={startProcessing}
          className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
        >
          Start Processing ({images.length} images)
        </button>
      ) : (
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600 mb-1">Stage: {stage}</p>
            <Progress value={progress} className="w-full" />
            <p className="text-sm text-gray-500 mt-1">{progress.toFixed(1)}%</p>
          </div>
          
          <div className="text-sm text-gray-600">
            <p>⏱️ Estimated time: {estimateTime(images.length)}</p>
            <p>💾 Disk space required: {estimateDiskSpace(images.length)}</p>
          </div>
        </div>
      )}
    </div>
  );
}

function estimateTime(imageCount) {
  // Rough estimates
  const minutesPerImage = 1.5;
  const totalMinutes = imageCount * minutesPerImage;
  
  if (totalMinutes < 60) {
    return `${Math.round(totalMinutes)} minutes`;
  } else {
    return `${(totalMinutes / 60).toFixed(1)} hours`;
  }
}

function estimateDiskSpace(imageCount) {
  // Rough estimates
  const gbPerImage = 0.1;
  return `${(imageCount * gbPerImage).toFixed(1)} GB`;
}
```

## 🚁 Recommended Workflow

1. **Image Selection**: User selects drone images
2. **Quick Preview**: Generate fast orthophoto (low res)
3. **Full Processing**: High-quality processing with all outputs
4. **Result Integration**: Import results back into main app
5. **Cloud Sync**: Upload processed orthomosaic to S3

## 💻 Hardware Requirements

### Minimum:
- 8GB RAM
- 4-core CPU
- 50GB free disk space
- DirectX 11 compatible GPU

### Recommended:
- 16GB+ RAM
- 8-core CPU
- 200GB SSD space
- NVIDIA GPU with 4GB+ VRAM

### For Large Projects (1000+ images):
- 32GB+ RAM
- 16-core CPU
- 500GB+ SSD space
- NVIDIA GPU with 8GB+ VRAM

## 🎯 Quick Start

1. Install Docker Desktop
2. Pull ODM image: `docker pull opendronemap/odm`
3. Add to your Electron app
4. Process your first project!

This integration brings professional-grade orthomosaic processing directly to the desktop app, enabling farmers to process their drone data without internet connectivity!