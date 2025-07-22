-- CreateTable
CREATE TABLE "AnnotationSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AnnotationSession_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ManualAnnotation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionId" TEXT NOT NULL,
    "weedType" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'LIKELY',
    "coordinates" JSONB NOT NULL,
    "geoCoordinates" JSONB,
    "centerLat" REAL,
    "centerLon" REAL,
    "notes" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verifiedBy" TEXT,
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ManualAnnotation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AnnotationSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "AnnotationSession_assetId_idx" ON "AnnotationSession"("assetId");

-- CreateIndex
CREATE INDEX "AnnotationSession_status_idx" ON "AnnotationSession"("status");

-- CreateIndex
CREATE INDEX "ManualAnnotation_sessionId_idx" ON "ManualAnnotation"("sessionId");

-- CreateIndex
CREATE INDEX "ManualAnnotation_weedType_idx" ON "ManualAnnotation"("weedType");

-- CreateIndex
CREATE INDEX "ManualAnnotation_centerLat_centerLon_idx" ON "ManualAnnotation"("centerLat", "centerLon");
