-- CreateEnum
CREATE TYPE "BatchJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PendingAnnotationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED');

-- CreateTable
CREATE TABLE "BatchJob" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "weedType" TEXT NOT NULL,
    "exemplars" JSONB NOT NULL,
    "textPrompt" TEXT,
    "status" "BatchJobStatus" NOT NULL DEFAULT 'QUEUED',
    "totalImages" INTEGER NOT NULL,
    "processedImages" INTEGER NOT NULL DEFAULT 0,
    "detectionsFound" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BatchJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendingAnnotation" (
    "id" TEXT NOT NULL,
    "batchJobId" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "weedType" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "polygon" JSONB NOT NULL,
    "bbox" JSONB NOT NULL,
    "geoPolygon" JSONB,
    "centerLat" DOUBLE PRECISION,
    "centerLon" DOUBLE PRECISION,
    "status" "PendingAnnotationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BatchJob_projectId_idx" ON "BatchJob"("projectId");

-- CreateIndex
CREATE INDEX "BatchJob_status_idx" ON "BatchJob"("status");

-- CreateIndex
CREATE INDEX "PendingAnnotation_batchJobId_idx" ON "PendingAnnotation"("batchJobId");

-- CreateIndex
CREATE INDEX "PendingAnnotation_assetId_idx" ON "PendingAnnotation"("assetId");

-- CreateIndex
CREATE INDEX "PendingAnnotation_status_idx" ON "PendingAnnotation"("status");

-- AddForeignKey
ALTER TABLE "BatchJob" ADD CONSTRAINT "BatchJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnnotation" ADD CONSTRAINT "PendingAnnotation_batchJobId_fkey" FOREIGN KEY ("batchJobId") REFERENCES "BatchJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingAnnotation" ADD CONSTRAINT "PendingAnnotation_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
