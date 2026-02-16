-- Add compliance layers for mission planning (allowed/exclusion geometry).

CREATE TABLE IF NOT EXISTS `ComplianceLayer` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `layerType` ENUM('ALLOWED_AREA', 'EXCLUSION_AREA', 'REFERENCE') NOT NULL,
    `sourceFormat` ENUM('GEOJSON', 'KML', 'SHAPEFILE', 'MANUAL') NOT NULL DEFAULT 'GEOJSON',
    `geometry` JSON NOT NULL,
    `bufferMeters` DOUBLE NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT TRUE,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ComplianceLayer_teamId_idx`(`teamId`),
    INDEX `ComplianceLayer_projectId_idx`(`projectId`),
    INDEX `ComplianceLayer_createdById_idx`(`createdById`),
    INDEX `ComplianceLayer_layerType_isActive_idx`(`layerType`, `isActive`),
    INDEX `ComplianceLayer_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @compliance_team_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'ComplianceLayer'
    AND constraint_name = 'ComplianceLayer_teamId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @compliance_team_fk_exists = 0,
  'ALTER TABLE `ComplianceLayer` ADD CONSTRAINT `ComplianceLayer_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compliance_project_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'ComplianceLayer'
    AND constraint_name = 'ComplianceLayer_projectId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @compliance_project_fk_exists = 0,
  'ALTER TABLE `ComplianceLayer` ADD CONSTRAINT `ComplianceLayer_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @compliance_creator_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'ComplianceLayer'
    AND constraint_name = 'ComplianceLayer_createdById_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @compliance_creator_fk_exists = 0,
  'ALTER TABLE `ComplianceLayer` ADD CONSTRAINT `ComplianceLayer_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
