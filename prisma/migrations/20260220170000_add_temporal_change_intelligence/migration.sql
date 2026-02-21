-- AlterTable
ALTER TABLE `Asset`
    ADD COLUMN `surveyId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `SprayPlan`
    ADD COLUMN `temporalRunId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Survey` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `surveyKey` VARCHAR(191) NOT NULL,
    `status` ENUM('ACTIVE', 'ARCHIVED') NOT NULL DEFAULT 'ACTIVE',
    `startedAt` DATETIME(3) NOT NULL,
    `endedAt` DATETIME(3) NOT NULL,
    `assetCount` INTEGER NOT NULL DEFAULT 0,
    `coverageGeometry` JSON NULL,
    `coverageMethod` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TemporalComparisonRun` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `baselineSurveyId` VARCHAR(191) NOT NULL,
    `comparisonSurveyId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` VARCHAR(191) NULL,
    `config` JSON NULL,
    `summary` JSON NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TemporalChangeItem` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `changeType` ENUM('NEW', 'PERSISTENT', 'RESOLVED', 'UNOBSERVED') NOT NULL,
    `species` VARCHAR(191) NOT NULL,
    `signalTypeBaseline` ENUM('DETECTION', 'MANUAL', 'SAM3') NULL,
    `signalIdBaseline` VARCHAR(191) NULL,
    `signalTypeComparison` ENUM('DETECTION', 'MANUAL', 'SAM3') NULL,
    `signalIdComparison` VARCHAR(191) NULL,
    `baselineLat` DOUBLE NULL,
    `baselineLon` DOUBLE NULL,
    `comparisonLat` DOUBLE NULL,
    `comparisonLon` DOUBLE NULL,
    `distanceM` DOUBLE NULL,
    `overlapScore` DOUBLE NULL,
    `confidence` DOUBLE NULL,
    `riskScore` DOUBLE NOT NULL DEFAULT 0,
    `geometry` JSON NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TemporalHotspot` (
    `id` VARCHAR(191) NOT NULL,
    `runId` VARCHAR(191) NOT NULL,
    `species` VARCHAR(191) NOT NULL,
    `changeMix` JSON NOT NULL,
    `itemCount` INTEGER NOT NULL,
    `avgConfidence` DOUBLE NULL,
    `avgRiskScore` DOUBLE NULL,
    `centroidLat` DOUBLE NOT NULL,
    `centroidLon` DOUBLE NOT NULL,
    `polygon` JSON NOT NULL,
    `areaHa` DOUBLE NOT NULL DEFAULT 0,
    `priorityScore` DOUBLE NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Asset_surveyId_idx` ON `Asset`(`surveyId`);

-- CreateIndex
CREATE INDEX `SprayPlan_temporalRunId_idx` ON `SprayPlan`(`temporalRunId`);

-- CreateIndex
CREATE UNIQUE INDEX `Survey_projectId_surveyKey_key` ON `Survey`(`projectId`, `surveyKey`);
CREATE INDEX `Survey_teamId_idx` ON `Survey`(`teamId`);
CREATE INDEX `Survey_projectId_startedAt_idx` ON `Survey`(`projectId`, `startedAt`);
CREATE INDEX `Survey_status_idx` ON `Survey`(`status`);

-- CreateIndex
CREATE INDEX `TemporalComparisonRun_teamId_idx` ON `TemporalComparisonRun`(`teamId`);
CREATE INDEX `TemporalComparisonRun_projectId_idx` ON `TemporalComparisonRun`(`projectId`);
CREATE INDEX `TemporalComparisonRun_baselineSurveyId_idx` ON `TemporalComparisonRun`(`baselineSurveyId`);
CREATE INDEX `TemporalComparisonRun_comparisonSurveyId_idx` ON `TemporalComparisonRun`(`comparisonSurveyId`);
CREATE INDEX `TemporalComparisonRun_createdById_idx` ON `TemporalComparisonRun`(`createdById`);
CREATE INDEX `TemporalComparisonRun_status_idx` ON `TemporalComparisonRun`(`status`);
CREATE INDEX `TemporalComparisonRun_createdAt_idx` ON `TemporalComparisonRun`(`createdAt`);

-- CreateIndex
CREATE INDEX `TemporalChangeItem_runId_idx` ON `TemporalChangeItem`(`runId`);
CREATE INDEX `TemporalChangeItem_changeType_idx` ON `TemporalChangeItem`(`changeType`);
CREATE INDEX `TemporalChangeItem_species_idx` ON `TemporalChangeItem`(`species`);
CREATE INDEX `TemporalChangeItem_riskScore_idx` ON `TemporalChangeItem`(`riskScore`);
CREATE INDEX `TemporalChangeItem_createdAt_idx` ON `TemporalChangeItem`(`createdAt`);

-- CreateIndex
CREATE INDEX `TemporalHotspot_runId_idx` ON `TemporalHotspot`(`runId`);
CREATE INDEX `TemporalHotspot_species_idx` ON `TemporalHotspot`(`species`);
CREATE INDEX `TemporalHotspot_priorityScore_idx` ON `TemporalHotspot`(`priorityScore`);
CREATE INDEX `TemporalHotspot_createdAt_idx` ON `TemporalHotspot`(`createdAt`);

-- AddForeignKey
ALTER TABLE `Survey`
    ADD CONSTRAINT `Survey_teamId_fkey`
    FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Survey`
    ADD CONSTRAINT `Survey_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `Asset`
    ADD CONSTRAINT `Asset_surveyId_fkey`
    FOREIGN KEY (`surveyId`) REFERENCES `Survey`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `TemporalComparisonRun`
    ADD CONSTRAINT `TemporalComparisonRun_teamId_fkey`
    FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalComparisonRun`
    ADD CONSTRAINT `TemporalComparisonRun_projectId_fkey`
    FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalComparisonRun`
    ADD CONSTRAINT `TemporalComparisonRun_baselineSurveyId_fkey`
    FOREIGN KEY (`baselineSurveyId`) REFERENCES `Survey`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalComparisonRun`
    ADD CONSTRAINT `TemporalComparisonRun_comparisonSurveyId_fkey`
    FOREIGN KEY (`comparisonSurveyId`) REFERENCES `Survey`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalComparisonRun`
    ADD CONSTRAINT `TemporalComparisonRun_createdById_fkey`
    FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalChangeItem`
    ADD CONSTRAINT `TemporalChangeItem_runId_fkey`
    FOREIGN KEY (`runId`) REFERENCES `TemporalComparisonRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `TemporalHotspot`
    ADD CONSTRAINT `TemporalHotspot_runId_fkey`
    FOREIGN KEY (`runId`) REFERENCES `TemporalComparisonRun`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `SprayPlan`
    ADD CONSTRAINT `SprayPlan_temporalRunId_fkey`
    FOREIGN KEY (`temporalRunId`) REFERENCES `TemporalComparisonRun`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
