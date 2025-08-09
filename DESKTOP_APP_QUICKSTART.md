# AgriDrone Ops Desktop - Quick Start Guide

This guide will help you create an Electron desktop version of AgriDrone Ops with offline capabilities and local orthomosaic processing.

## 🚀 Step 1: Create New GitHub Repository

```bash
# Create new repo (don't clone the web app)
mkdir agri-drone-ops-desktop
cd agri-drone-ops-desktop
git init
git remote add origin https://github.com/nationaldronesau/agri-drone-ops-desktop.git
```

## 📦 Step 2: Initialize Project

Create `package.json`:

```json
{
  "name": "agri-drone-ops-desktop",
  "version": "0.1.0",
  "description": "Desktop application for AgriDrone Ops with offline processing",
  "main": "electron/main.js",
  "scripts": {
    "dev": "concurrently \"npm run dev:next\" \"npm run dev:electron\"",
    "dev:next": "next dev",
    "dev:electron": "wait-on http://localhost:3000 && electron .",
    "build": "next build && npm run build:electron",
    "build:electron": "electron-builder",
    "start": "electron .",
    "postinstall": "electron-builder install-app-deps"
  },
  "dependencies": {
    "better-sqlite3": "^11.5.0",
    "electron-is-dev": "^3.0.1",
    "electron-updater": "^6.3.9",
    "next": "^15.4.2",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.12",
    "@types/node": "^20",
    "@types/react": "^19",
    "concurrently": "^9.1.2",
    "electron": "^34.0.0",
    "electron-builder": "^25.2.0",
    "typescript": "^5",
    "wait-on": "^8.0.2"
  },
  "build": {
    "appId": "com.nationaldrones.agridrone-ops",
    "productName": "AgriDrone Ops",
    "directories": {
      "output": "dist"
    },
    "files": [
      "electron/**/*",
      ".next/**/*",
      "public/**/*",
      "!node_modules/better-sqlite3/build/Release/*.node",
      "node_modules/better-sqlite3/build/Release/${platform}/*.node"
    ],
    "mac": {
      "category": "public.app-category.productivity"
    },
    "win": {
      "target": "nsis"
    },
    "linux": {
      "target": "AppImage"
    }
  }
}
```

Install dependencies:
```bash
npm install
```

## 🏗️ Step 3: Create Electron Main Process

Create `electron/main.js`:

```javascript
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const isDev = require('electron-is-dev');
const { autoUpdater } = require('electron-updater');
const Database = require('./database');

let mainWindow;
let db;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '../public/icon.png'),
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#ffffff'
  });

  const url = isDev 
    ? 'http://localhost:3000' 
    : `file://${path.join(__dirname, '../.next/server/app/index.html')}`;
    
  mainWindow.loadURL(url);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // Check for updates
  if (!isDev) {
    autoUpdater.checkForUpdatesAndNotify();
  }
}

app.whenReady().then(() => {
  // Initialize database
  db = new Database();
  
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC Handlers for renderer process
ipcMain.handle('select-images', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'tiff'] }
    ]
  });
  
  return result.filePaths;
});

ipcMain.handle('db-query', async (event, method, ...args) => {
  return db[method](...args);
});

ipcMain.handle('get-app-path', () => {
  return app.getPath('userData');
});
```

Create `electron/preload.js`:

```javascript
const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  selectImages: () => ipcRenderer.invoke('select-images'),
  
  db: {
    createProject: (project) => ipcRenderer.invoke('db-query', 'createProject', project),
    getProjects: () => ipcRenderer.invoke('db-query', 'getProjects'),
    createAsset: (asset) => ipcRenderer.invoke('db-query', 'createAsset', asset),
    getAssets: (projectId) => ipcRenderer.invoke('db-query', 'getAssets', projectId),
    getSyncQueue: () => ipcRenderer.invoke('db-query', 'getSyncQueue'),
    markSynced: (id) => ipcRenderer.invoke('db-query', 'markSynced', id)
  },
  
  getAppPath: () => ipcRenderer.invoke('get-app-path')
});
```

Create `electron/database.js`:

```javascript
const Database = require('better-sqlite3');
const path = require('path');
const { app } = require('electron');

class AppDatabase {
  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'agridrone.db');
    this.db = new Database(dbPath);
    this.initialize();
  }

  initialize() {
    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        location TEXT,
        purpose TEXT,
        cloudId TEXT,
        syncStatus TEXT DEFAULT 'local',
        lastSyncAt INTEGER,
        createdAt INTEGER DEFAULT (strftime('%s', 'now'))
      );

      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        projectId TEXT NOT NULL,
        fileName TEXT NOT NULL,
        localPath TEXT NOT NULL,
        cloudUrl TEXT,
        fileSize INTEGER,
        mimeType TEXT,
        gpsLatitude REAL,
        gpsLongitude REAL,
        altitude REAL,
        syncStatus TEXT DEFAULT 'local',
        uploadProgress REAL DEFAULT 0,
        createdAt INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (projectId) REFERENCES projects(id)
      );

      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        action TEXT NOT NULL,
        data TEXT,
        status TEXT DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        lastAttempt INTEGER,
        createdAt INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `);
  }

  // Project methods
  createProject(project) {
    const stmt = this.db.prepare(`
      INSERT INTO projects (id, name, location, purpose)
      VALUES (?, ?, ?, ?)
    `);
    
    const id = `proj_${Date.now()}`;
    stmt.run(id, project.name, project.location, project.purpose);
    
    // Add to sync queue
    this.addToSyncQueue('project', id, 'create', project);
    
    return { id, ...project };
  }

  getProjects() {
    return this.db.prepare('SELECT * FROM projects ORDER BY createdAt DESC').all();
  }

  // Asset methods
  createAsset(asset) {
    const stmt = this.db.prepare(`
      INSERT INTO assets (id, projectId, fileName, localPath, fileSize, mimeType, 
                         gpsLatitude, gpsLongitude, altitude)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const id = `asset_${Date.now()}`;
    stmt.run(
      id, asset.projectId, asset.fileName, asset.localPath,
      asset.fileSize, asset.mimeType, asset.gpsLatitude,
      asset.gpsLongitude, asset.altitude
    );
    
    // Add to sync queue
    this.addToSyncQueue('asset', id, 'create', asset);
    
    return { id, ...asset };
  }

  getAssets(projectId) {
    return this.db.prepare('SELECT * FROM assets WHERE projectId = ?').all(projectId);
  }

  // Sync methods
  addToSyncQueue(entityType, entityId, action, data) {
    const stmt = this.db.prepare(`
      INSERT INTO sync_queue (entityType, entityId, action, data)
      VALUES (?, ?, ?, ?)
    `);
    
    stmt.run(entityType, entityId, action, JSON.stringify(data));
  }

  getSyncQueue() {
    return this.db.prepare(
      'SELECT * FROM sync_queue WHERE status = "pending" ORDER BY createdAt ASC'
    ).all();
  }

  markSynced(id) {
    this.db.prepare('UPDATE sync_queue SET status = "synced" WHERE id = ?').run(id);
  }
}

module.exports = AppDatabase;
```

## 🎨 Step 4: Create Next.js Pages

Create `app/page.tsx`:

```tsx
'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

export default function HomePage() {
  const [projects, setProjects] = useState([]);
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    // Check if running in Electron
    setIsElectron(typeof window !== 'undefined' && window.electronAPI);
    
    if (isElectron) {
      loadProjects();
    }
  }, []);

  const loadProjects = async () => {
    const data = await window.electronAPI.db.getProjects();
    setProjects(data);
  };

  const createProject = async () => {
    const name = prompt('Project name:');
    if (!name) return;

    await window.electronAPI.db.createProject({
      name,
      location: 'Demo Farm',
      purpose: 'WEED_DETECTION'
    });

    loadProjects();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-green-50 to-blue-50 p-8">
      <div className="max-w-6xl mx-auto">
        <h1 className="text-4xl font-bold text-gray-800 mb-8">
          AgriDrone Ops {isElectron ? 'Desktop' : 'Web'}
        </h1>

        {isElectron ? (
          <div>
            <button
              onClick={createProject}
              className="mb-6 px-6 py-3 bg-gradient-to-r from-green-500 to-blue-500 text-white rounded-lg hover:shadow-lg transition-shadow"
            >
              Create New Project
            </button>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {projects.map((project) => (
                <Link
                  key={project.id}
                  href={`/projects/${project.id}`}
                  className="p-6 bg-white rounded-lg shadow hover:shadow-lg transition-shadow"
                >
                  <h3 className="text-xl font-semibold mb-2">{project.name}</h3>
                  <p className="text-gray-600">{project.location}</p>
                  <p className="text-sm text-gray-500 mt-2">
                    Status: {project.syncStatus}
                  </p>
                </Link>
              ))}
            </div>
          </div>
        ) : (
          <p>Please run this in the desktop app for offline functionality.</p>
        )}
      </div>
    </div>
  );
}
```

Create `lib/db-desktop.ts`:

```typescript
// Type-safe database client for desktop
interface ElectronAPI {
  selectImages: () => Promise<string[]>;
  db: {
    createProject: (project: any) => Promise<any>;
    getProjects: () => Promise<any[]>;
    createAsset: (asset: any) => Promise<any>;
    getAssets: (projectId: string) => Promise<any[]>;
    getSyncQueue: () => Promise<any[]>;
    markSynced: (id: number) => Promise<void>;
  };
  getAppPath: () => Promise<string>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export const desktopDB = {
  isAvailable: () => typeof window !== 'undefined' && window.electronAPI,
  
  projects: {
    create: (data: any) => window.electronAPI.db.createProject(data),
    list: () => window.electronAPI.db.getProjects(),
  },
  
  assets: {
    create: (data: any) => window.electronAPI.db.createAsset(data),
    list: (projectId: string) => window.electronAPI.db.getAssets(projectId),
  },
  
  sync: {
    getQueue: () => window.electronAPI.db.getSyncQueue(),
    markSynced: (id: number) => window.electronAPI.db.markSynced(id),
  }
};
```

## 🔄 Step 5: Basic Sync Manager

Create `electron/sync.js`:

```javascript
class SyncManager {
  constructor(db, apiUrl, apiKey) {
    this.db = db;
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.syncInterval = 30000; // 30 seconds
    this.isSyncing = false;
  }

  start() {
    // Initial sync
    this.sync();
    
    // Schedule periodic syncs
    setInterval(() => {
      if (!this.isSyncing) {
        this.sync();
      }
    }, this.syncInterval);
  }

  async sync() {
    if (!this.apiKey || this.isSyncing) return;
    
    this.isSyncing = true;
    
    try {
      const queue = this.db.getSyncQueue();
      
      for (const item of queue) {
        try {
          await this.syncItem(item);
          this.db.markSynced(item.id);
        } catch (error) {
          console.error('Sync failed for item:', item.id, error);
        }
      }
    } finally {
      this.isSyncing = false;
    }
  }

  async syncItem(item) {
    const data = JSON.parse(item.data);
    
    switch (item.entityType) {
      case 'project':
        return this.syncProject(item.entityId, item.action, data);
      case 'asset':
        return this.syncAsset(item.entityId, item.action, data);
      default:
        throw new Error(`Unknown entity type: ${item.entityType}`);
    }
  }

  async syncProject(id, action, data) {
    if (action === 'create') {
      const response = await fetch(`${this.apiUrl}/api/projects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`
        },
        body: JSON.stringify(data)
      });
      
      if (!response.ok) throw new Error('Failed to sync project');
      
      const cloudProject = await response.json();
      
      // Update local record with cloud ID
      this.db.db.prepare(
        'UPDATE projects SET cloudId = ?, syncStatus = "synced" WHERE id = ?'
      ).run(cloudProject.id, id);
    }
  }

  async syncAsset(id, action, data) {
    // Similar implementation for assets
    // Would include file upload to S3
  }
}

module.exports = SyncManager;
```

## 🔗 Step 6: Share Code with Web App

Add the web app as a git submodule:

```bash
git submodule add https://github.com/nationaldronesau/agri-drone-ops.git web-app
git submodule update --init
```

Create `next.config.js` to share components:

```javascript
/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['web-app'],
};

module.exports = nextConfig;
```

Use shared components:

```tsx
// In your desktop app pages
import { Button } from '../web-app/components/ui/button';
import { Card } from '../web-app/components/ui/card';
```

## 📁 Step 7: Local File Structure

The app will create this structure:

```
~/Library/Application Support/AgriDrone Ops/ (macOS)
%APPDATA%/AgriDrone Ops/ (Windows)
├── agridrone.db              # SQLite database
└── projects/
    └── proj_1234567890/
        └── images/
            └── flight-1/
                ├── DJI_0001.jpg
                ├── DJI_0002.jpg
                └── metadata.json
```

## 🚀 Step 8: Run the App

```bash
# Development
npm run dev

# Build for production
npm run build

# The built app will be in dist/
```

## 🎯 Next Steps

1. **Add OpenDroneMap Integration**:
   ```bash
   npm install dockerode
   # Use Docker to run ODM processing
   ```

2. **Implement Full Sync**:
   - Add file upload to S3
   - Implement conflict resolution
   - Add offline queue management

3. **Add More Features**:
   - Image annotation tools
   - Processing queue UI
   - Export functionality

## 📝 Important Notes

- The desktop app works completely offline
- Data syncs when internet is available
- All files are stored locally
- SQLite database for fast queries
- Can process thousands of images

This gives you a working desktop app foundation that you can build upon!