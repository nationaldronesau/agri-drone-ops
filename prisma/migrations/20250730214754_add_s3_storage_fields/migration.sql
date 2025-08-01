-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Asset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageUrl" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "s3Key" TEXT,
    "s3Bucket" TEXT,
    "storageType" TEXT NOT NULL DEFAULT 'local',
    "uploadedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "flightSession" TEXT,
    "flightDate" DATETIME,
    "metadata" JSONB,
    "gpsLatitude" REAL,
    "gpsLongitude" REAL,
    "altitude" REAL,
    "gimbalRoll" REAL,
    "gimbalPitch" REAL,
    "gimbalYaw" REAL,
    "cameraFov" REAL,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "lrfDistance" REAL,
    "lrfTargetLat" REAL,
    "lrfTargetLon" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,
    CONSTRAINT "Asset_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Asset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Asset" ("altitude", "cameraFov", "createdAt", "createdById", "fileName", "fileSize", "flightDate", "flightSession", "gimbalPitch", "gimbalRoll", "gimbalYaw", "gpsLatitude", "gpsLongitude", "id", "imageHeight", "imageWidth", "lrfDistance", "lrfTargetLat", "lrfTargetLon", "metadata", "mimeType", "projectId", "storageUrl", "thumbnailUrl") SELECT "altitude", "cameraFov", "createdAt", "createdById", "fileName", "fileSize", "flightDate", "flightSession", "gimbalPitch", "gimbalRoll", "gimbalYaw", "gpsLatitude", "gpsLongitude", "id", "imageHeight", "imageWidth", "lrfDistance", "lrfTargetLat", "lrfTargetLon", "metadata", "mimeType", "projectId", "storageUrl", "thumbnailUrl" FROM "Asset";
DROP TABLE "Asset";
ALTER TABLE "new_Asset" RENAME TO "Asset";
CREATE INDEX "Asset_projectId_idx" ON "Asset"("projectId");
CREATE INDEX "Asset_flightSession_idx" ON "Asset"("flightSession");
CREATE INDEX "Asset_gpsLatitude_gpsLongitude_idx" ON "Asset"("gpsLatitude", "gpsLongitude");
CREATE INDEX "Asset_s3Key_idx" ON "Asset"("s3Key");
CREATE TABLE "new_Orthomosaic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "originalFile" TEXT NOT NULL,
    "tilesetPath" TEXT,
    "fileSize" BIGINT NOT NULL,
    "s3Key" TEXT,
    "s3TilesetKey" TEXT,
    "s3Bucket" TEXT,
    "storageType" TEXT NOT NULL DEFAULT 'local',
    "bounds" JSONB NOT NULL,
    "centerLat" REAL NOT NULL,
    "centerLon" REAL NOT NULL,
    "minZoom" INTEGER NOT NULL DEFAULT 10,
    "maxZoom" INTEGER NOT NULL DEFAULT 22,
    "captureDate" DATETIME,
    "resolution" REAL,
    "area" REAL,
    "imageCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "processingLog" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Orthomosaic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Orthomosaic" ("area", "bounds", "captureDate", "centerLat", "centerLon", "createdAt", "description", "fileSize", "id", "imageCount", "maxZoom", "minZoom", "name", "originalFile", "processingLog", "projectId", "resolution", "status", "tilesetPath", "updatedAt") SELECT "area", "bounds", "captureDate", "centerLat", "centerLon", "createdAt", "description", "fileSize", "id", "imageCount", "maxZoom", "minZoom", "name", "originalFile", "processingLog", "projectId", "resolution", "status", "tilesetPath", "updatedAt" FROM "Orthomosaic";
DROP TABLE "Orthomosaic";
ALTER TABLE "new_Orthomosaic" RENAME TO "Orthomosaic";
CREATE INDEX "Orthomosaic_projectId_idx" ON "Orthomosaic"("projectId");
CREATE INDEX "Orthomosaic_status_idx" ON "Orthomosaic"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
