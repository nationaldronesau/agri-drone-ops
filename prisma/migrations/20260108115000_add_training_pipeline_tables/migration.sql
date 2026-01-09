-- CreateTable
CREATE TABLE `TrainingDataset` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `s3Path` VARCHAR(191) NOT NULL,
    `s3Bucket` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NULL,
    `imageCount` INTEGER NOT NULL,
    `labelCount` INTEGER NOT NULL,
    `classes` VARCHAR(191) NOT NULL,
    `trainCount` INTEGER NOT NULL,
    `valCount` INTEGER NOT NULL,
    `testCount` INTEGER NOT NULL,
    `augmentationPreset` VARCHAR(191) NULL,
    `augmentationConfig` VARCHAR(191) NULL,
    `augmentedImageCount` INTEGER NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TrainingDataset_teamId_idx`(`teamId`),
    INDEX `TrainingDataset_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainedModel` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `version` INTEGER NOT NULL,
    `displayName` VARCHAR(191) NULL,
    `description` VARCHAR(191) NULL,
    `s3Path` VARCHAR(191) NOT NULL,
    `s3Bucket` VARCHAR(191) NOT NULL,
    `weightsFile` VARCHAR(191) NOT NULL DEFAULT 'best.pt',
    `fileSizeBytes` INTEGER NULL,
    `classes` VARCHAR(191) NOT NULL,
    `classCount` INTEGER NOT NULL,
    `mAP50` DOUBLE NULL,
    `mAP5095` DOUBLE NULL,
    `precision` DOUBLE NULL,
    `recall` DOUBLE NULL,
    `f1Score` DOUBLE NULL,
    `classMetrics` VARCHAR(191) NULL,
    `baseModel` VARCHAR(191) NOT NULL,
    `trainedOnImages` INTEGER NULL,
    `trainedEpochs` INTEGER NULL,
    `status` ENUM('TRAINING', 'READY', 'ACTIVE', 'ARCHIVED', 'FAILED') NOT NULL DEFAULT 'READY',
    `isActive` BOOLEAN NOT NULL DEFAULT false,
    `inferenceCount` INTEGER NOT NULL DEFAULT 0,
    `lastUsedAt` DATETIME(3) NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TrainedModel_name_version_teamId_key`(`name`, `version`, `teamId`),
    INDEX `TrainedModel_teamId_idx`(`teamId`),
    INDEX `TrainedModel_status_idx`(`status`),
    INDEX `TrainedModel_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainingJob` (
    `id` VARCHAR(191) NOT NULL,
    `datasetId` VARCHAR(191) NOT NULL,
    `baseModel` VARCHAR(191) NOT NULL,
    `epochs` INTEGER NOT NULL DEFAULT 100,
    `batchSize` INTEGER NOT NULL DEFAULT 16,
    `imageSize` INTEGER NOT NULL DEFAULT 640,
    `learningRate` DOUBLE NOT NULL DEFAULT 0.01,
    `trainingConfig` VARCHAR(191) NULL,
    `status` ENUM('QUEUED', 'PREPARING', 'RUNNING', 'UPLOADING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `currentEpoch` INTEGER NOT NULL DEFAULT 0,
    `progress` DOUBLE NOT NULL DEFAULT 0,
    `ec2JobId` VARCHAR(191) NULL,
    `currentMetrics` VARCHAR(191) NULL,
    `metricsHistory` VARCHAR(191) NULL,
    `finalMAP50` DOUBLE NULL,
    `finalMAP5095` DOUBLE NULL,
    `finalPrecision` DOUBLE NULL,
    `finalRecall` DOUBLE NULL,
    `finalF1` DOUBLE NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `estimatedMinutes` INTEGER NULL,
    `errorMessage` VARCHAR(191) NULL,
    `errorDetails` VARCHAR(191) NULL,
    `trainedModelId` VARCHAR(191) NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `TrainingJob_trainedModelId_key`(`trainedModelId`),
    INDEX `TrainingJob_teamId_idx`(`teamId`),
    INDEX `TrainingJob_status_idx`(`status`),
    INDEX `TrainingJob_datasetId_idx`(`datasetId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TrainingDataset` ADD CONSTRAINT `TrainingDataset_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `TrainingDataset` ADD CONSTRAINT `TrainingDataset_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_datasetId_fkey` FOREIGN KEY (`datasetId`) REFERENCES `TrainingDataset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_trainedModelId_fkey` FOREIGN KEY (`trainedModelId`) REFERENCES `TrainedModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainedModel` ADD CONSTRAINT `TrainedModel_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
