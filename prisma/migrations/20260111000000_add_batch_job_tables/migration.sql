-- CreateTable
CREATE TABLE `BatchJob` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `weedType` VARCHAR(191) NOT NULL,
    `exemplars` JSON NOT NULL,
    `textPrompt` TEXT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `totalImages` INTEGER NOT NULL,
    `processedImages` INTEGER NOT NULL DEFAULT 0,
    `detectionsFound` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,

    INDEX `BatchJob_projectId_idx`(`projectId`),
    INDEX `BatchJob_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PendingAnnotation` (
    `id` VARCHAR(191) NOT NULL,
    `batchJobId` VARCHAR(191) NOT NULL,
    `assetId` VARCHAR(191) NOT NULL,
    `weedType` VARCHAR(191) NOT NULL,
    `confidence` DOUBLE NOT NULL,
    `polygon` JSON NOT NULL,
    `bbox` JSON NOT NULL,
    `geoPolygon` JSON NULL,
    `centerLat` DOUBLE NULL,
    `centerLon` DOUBLE NULL,
    `status` ENUM('PENDING', 'ACCEPTED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `reviewedAt` DATETIME(3) NULL,
    `reviewedBy` VARCHAR(191) NULL,
    `rejectionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PendingAnnotation_batchJobId_idx`(`batchJobId`),
    INDEX `PendingAnnotation_assetId_idx`(`assetId`),
    INDEX `PendingAnnotation_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `BatchJob` ADD CONSTRAINT `BatchJob_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingAnnotation` ADD CONSTRAINT `PendingAnnotation_batchJobId_fkey` FOREIGN KEY (`batchJobId`) REFERENCES `BatchJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PendingAnnotation` ADD CONSTRAINT `PendingAnnotation_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
