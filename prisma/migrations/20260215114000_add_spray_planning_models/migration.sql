-- Add spray planning and mission execution tables.

CREATE TABLE IF NOT EXISTS `SprayPlan` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` ENUM('QUEUED', 'PROCESSING', 'READY', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `progress` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` VARCHAR(191) NULL,
    `config` JSON NULL,
    `summary` JSON NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SprayPlan_teamId_idx`(`teamId`),
    INDEX `SprayPlan_projectId_idx`(`projectId`),
    INDEX `SprayPlan_createdById_idx`(`createdById`),
    INDEX `SprayPlan_status_idx`(`status`),
    INDEX `SprayPlan_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SprayMission` (
    `id` VARCHAR(191) NOT NULL,
    `sprayPlanId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'ready',
    `zoneCount` INTEGER NOT NULL DEFAULT 0,
    `totalAreaHa` DOUBLE NOT NULL DEFAULT 0,
    `chemicalLiters` DOUBLE NOT NULL DEFAULT 0,
    `estimatedDistanceM` DOUBLE NOT NULL DEFAULT 0,
    `estimatedDurationMin` DOUBLE NOT NULL DEFAULT 0,
    `routeGeoJson` JSON NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SprayMission_sprayPlanId_idx`(`sprayPlanId`),
    INDEX `SprayMission_sequence_idx`(`sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `SprayZone` (
    `id` VARCHAR(191) NOT NULL,
    `sprayPlanId` VARCHAR(191) NOT NULL,
    `missionId` VARCHAR(191) NULL,
    `species` VARCHAR(191) NOT NULL,
    `detectionCount` INTEGER NOT NULL DEFAULT 0,
    `averageConfidence` DOUBLE NULL,
    `priorityScore` DOUBLE NULL,
    `centroidLat` DOUBLE NOT NULL,
    `centroidLon` DOUBLE NOT NULL,
    `polygon` JSON NOT NULL,
    `areaHa` DOUBLE NOT NULL DEFAULT 0,
    `recommendedDosePerHa` DOUBLE NULL,
    `recommendedLiters` DOUBLE NULL,
    `recommendationSource` VARCHAR(191) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SprayZone_sprayPlanId_idx`(`sprayPlanId`),
    INDEX `SprayZone_missionId_idx`(`missionId`),
    INDEX `SprayZone_species_idx`(`species`),
    INDEX `SprayZone_priorityScore_idx`(`priorityScore`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @spray_plan_team_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayPlan'
    AND constraint_name = 'SprayPlan_teamId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_plan_team_fk_exists = 0,
  'ALTER TABLE `SprayPlan` ADD CONSTRAINT `SprayPlan_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spray_plan_project_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayPlan'
    AND constraint_name = 'SprayPlan_projectId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_plan_project_fk_exists = 0,
  'ALTER TABLE `SprayPlan` ADD CONSTRAINT `SprayPlan_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spray_plan_creator_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayPlan'
    AND constraint_name = 'SprayPlan_createdById_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_plan_creator_fk_exists = 0,
  'ALTER TABLE `SprayPlan` ADD CONSTRAINT `SprayPlan_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spray_mission_plan_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayMission'
    AND constraint_name = 'SprayMission_sprayPlanId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_mission_plan_fk_exists = 0,
  'ALTER TABLE `SprayMission` ADD CONSTRAINT `SprayMission_sprayPlanId_fkey` FOREIGN KEY (`sprayPlanId`) REFERENCES `SprayPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spray_zone_plan_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayZone'
    AND constraint_name = 'SprayZone_sprayPlanId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_zone_plan_fk_exists = 0,
  'ALTER TABLE `SprayZone` ADD CONSTRAINT `SprayZone_sprayPlanId_fkey` FOREIGN KEY (`sprayPlanId`) REFERENCES `SprayPlan`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @spray_zone_mission_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'SprayZone'
    AND constraint_name = 'SprayZone_missionId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @spray_zone_mission_fk_exists = 0,
  'ALTER TABLE `SprayZone` ADD CONSTRAINT `SprayZone_missionId_fkey` FOREIGN KEY (`missionId`) REFERENCES `SprayMission`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
