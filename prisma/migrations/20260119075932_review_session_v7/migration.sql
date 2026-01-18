-- AlterTable
ALTER TABLE `Detection` ADD COLUMN `geoDsmCorrected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `inferenceJobId` VARCHAR(191) NULL,
    ADD COLUMN `preprocessingMeta` JSON NULL,
    MODIFY `jobId` VARCHAR(191) NULL,
    MODIFY `type` ENUM('AI', 'MANUAL', 'YOLO_LOCAL') NOT NULL,
    MODIFY `geoCoordinates` JSON NULL;

-- CreateTable
CREATE TABLE `ReviewSession` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `workflowType` VARCHAR(191) NOT NULL,
    `targetType` VARCHAR(191) NOT NULL,
    `roboflowProjectId` VARCHAR(191) NULL,
    `yoloModelName` VARCHAR(191) NULL,
    `confidenceThreshold` DOUBLE NULL,
    `weedTypeFilter` VARCHAR(191) NULL,
    `assetIds` JSON NOT NULL,
    `assetCount` INTEGER NOT NULL,
    `inferenceJobIds` JSON NULL,
    `batchJobIds` JSON NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'active',
    `itemsReviewed` INTEGER NOT NULL DEFAULT 0,
    `itemsAccepted` INTEGER NOT NULL DEFAULT 0,
    `itemsRejected` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ReviewSession_teamId_idx`(`teamId`),
    INDEX `ReviewSession_projectId_idx`(`projectId`),
    INDEX `ReviewSession_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewSessionEdit` (
    `id` VARCHAR(191) NOT NULL,
    `reviewSessionId` VARCHAR(191) NOT NULL,
    `sourceType` VARCHAR(191) NOT NULL,
    `sourceId` VARCHAR(191) NOT NULL,
    `newAnnotationId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ReviewSessionEdit_reviewSessionId_idx`(`reviewSessionId`),
    UNIQUE INDEX `ReviewSessionEdit_reviewSessionId_sourceType_sourceId_key`(`reviewSessionId`, `sourceType`, `sourceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `YOLOInferenceJob` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `reviewSessionId` VARCHAR(191) NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `assetIds` JSON NULL,
    `modelName` VARCHAR(191) NOT NULL,
    `confidence` DOUBLE NOT NULL DEFAULT 0.5,
    `status` ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `processedImages` INTEGER NOT NULL DEFAULT 0,
    `totalImages` INTEGER NOT NULL,
    `detectionsFound` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,

    INDEX `YOLOInferenceJob_teamId_idx`(`teamId`),
    INDEX `YOLOInferenceJob_projectId_idx`(`projectId`),
    INDEX `YOLOInferenceJob_reviewSessionId_idx`(`reviewSessionId`),
    INDEX `YOLOInferenceJob_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Detection_inferenceJobId_idx` ON `Detection`(`inferenceJobId`);

-- AddForeignKey
ALTER TABLE `Detection` ADD CONSTRAINT `Detection_inferenceJobId_fkey` FOREIGN KEY (`inferenceJobId`) REFERENCES `YOLOInferenceJob`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSession` ADD CONSTRAINT `ReviewSession_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSession` ADD CONSTRAINT `ReviewSession_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSession` ADD CONSTRAINT `ReviewSession_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSessionEdit` ADD CONSTRAINT `ReviewSessionEdit_reviewSessionId_fkey` FOREIGN KEY (`reviewSessionId`) REFERENCES `ReviewSession`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `YOLOInferenceJob` ADD CONSTRAINT `YOLOInferenceJob_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `YOLOInferenceJob` ADD CONSTRAINT `YOLOInferenceJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `YOLOInferenceJob` ADD CONSTRAINT `YOLOInferenceJob_reviewSessionId_fkey` FOREIGN KEY (`reviewSessionId`) REFERENCES `ReviewSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `YOLOInferenceJob` ADD CONSTRAINT `YOLOInferenceJob_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

