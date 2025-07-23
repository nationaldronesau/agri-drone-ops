-- CreateTable
CREATE TABLE "Orthomosaic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "originalFile" TEXT NOT NULL,
    "tilesetPath" TEXT,
    "fileSize" BIGINT NOT NULL,
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

-- CreateIndex
CREATE INDEX "Orthomosaic_projectId_idx" ON "Orthomosaic"("projectId");

-- CreateIndex
CREATE INDEX "Orthomosaic_status_idx" ON "Orthomosaic"("status");
