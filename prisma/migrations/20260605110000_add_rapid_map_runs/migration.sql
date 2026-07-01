-- Add Rapid Map run tracking for metadata-based map generation.
-- The run stores job/provenance/status separately from the generated Orthomosaic.

CREATE TABLE `RapidMapRun` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `orthomosaicId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` TEXT NULL,
    `sourceType` ENUM('S3_PREFIX', 'ASSET_SET', 'PROCESSING_NODE_PATH') NOT NULL DEFAULT 'S3_PREFIX',
    `sourcePath` TEXT NULL,
    `sourceAssetIds` JSON NULL,
    `preset` ENUM('INITIAL_TRIAL', 'SHARPER_REVIEW', 'COVERAGE_CHECK') NOT NULL DEFAULT 'INITIAL_TRIAL',
    `status` ENUM('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `queueJobId` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `config` JSON NULL,
    `processingLog` JSON NULL,
    `artifactManifest` JSON NULL,
    `runSummary` JSON NULL,
    `outputS3Prefix` TEXT NULL,
    `outputBucket` VARCHAR(191) NULL,
    `sourceImageCount` INTEGER NULL,
    `renderedImageCount` INTEGER NULL,
    `excludedImageCount` INTEGER NULL,
    `estimatedErrorMeters` DOUBLE NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RapidMapRun_teamId_idx`(`teamId`),
    INDEX `RapidMapRun_projectId_idx`(`projectId`),
    INDEX `RapidMapRun_createdById_idx`(`createdById`),
    INDEX `RapidMapRun_orthomosaicId_idx`(`orthomosaicId`),
    INDEX `RapidMapRun_status_idx`(`status`),
    INDEX `RapidMapRun_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `RapidMapRun`
    ADD CONSTRAINT `RapidMapRun_teamId_fkey`
    FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `RapidMapRun`
    ADD CONSTRAINT `RapidMapRun_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `RapidMapRun`
    ADD CONSTRAINT `RapidMapRun_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `RapidMapRun`
    ADD CONSTRAINT `RapidMapRun_orthomosaicId_fkey`
    FOREIGN KEY (`orthomosaicId`) REFERENCES `Orthomosaic`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
