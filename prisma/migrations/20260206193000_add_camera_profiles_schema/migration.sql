-- Align database schema with CameraProfile + project inference profile fields.
-- This migration is written to be idempotent because some environments may
-- have partial/manual schema changes applied.

CREATE TABLE IF NOT EXISTS `CameraProfile` (
    `id` VARCHAR(191) NOT NULL,
    `teamId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `fov` DOUBLE NULL,
    `calibratedFocalLength` DOUBLE NULL,
    `opticalCenterX` DOUBLE NULL,
    `opticalCenterY` DOUBLE NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

SET @project_camera_profile_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'Project'
    AND column_name = 'cameraProfileId'
);
SET @sql := IF(
  @project_camera_profile_col_exists = 0,
  'ALTER TABLE `Project` ADD COLUMN `cameraProfileId` VARCHAR(191) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @project_features_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'Project'
    AND column_name = 'features'
);
SET @sql := IF(
  @project_features_col_exists = 0,
  'ALTER TABLE `Project` ADD COLUMN `features` JSON NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @project_inference_backend_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'Project'
    AND column_name = 'inferenceBackend'
);
SET @sql := IF(
  @project_inference_backend_col_exists = 0,
  'ALTER TABLE `Project` ADD COLUMN `inferenceBackend` ENUM(\'LOCAL\', \'ROBOFLOW\', \'AUTO\') NOT NULL DEFAULT \'AUTO\'',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @asset_camera_profile_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'Asset'
    AND column_name = 'cameraProfileId'
);
SET @sql := IF(
  @asset_camera_profile_col_exists = 0,
  'ALTER TABLE `Asset` ADD COLUMN `cameraProfileId` VARCHAR(191) NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @camera_profile_team_name_unique_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND index_name = 'CameraProfile_teamId_name_key'
);
SET @sql := IF(
  @camera_profile_team_name_unique_exists = 0,
  'CREATE UNIQUE INDEX `CameraProfile_teamId_name_key` ON `CameraProfile`(`teamId`, `name`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @camera_profile_team_idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND index_name = 'CameraProfile_teamId_idx'
);
SET @sql := IF(
  @camera_profile_team_idx_exists = 0,
  'CREATE INDEX `CameraProfile_teamId_idx` ON `CameraProfile`(`teamId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @project_camera_profile_idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'Project'
    AND index_name = 'Project_cameraProfileId_idx'
);
SET @sql := IF(
  @project_camera_profile_idx_exists = 0,
  'CREATE INDEX `Project_cameraProfileId_idx` ON `Project`(`cameraProfileId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @asset_camera_profile_idx_exists := (
  SELECT COUNT(1)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'Asset'
    AND index_name = 'Asset_cameraProfileId_idx'
);
SET @sql := IF(
  @asset_camera_profile_idx_exists = 0,
  'CREATE INDEX `Asset_cameraProfileId_idx` ON `Asset`(`cameraProfileId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @camera_profile_team_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND constraint_name = 'CameraProfile_teamId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @camera_profile_team_fk_exists = 0,
  'ALTER TABLE `CameraProfile` ADD CONSTRAINT `CameraProfile_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @project_camera_profile_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'Project'
    AND constraint_name = 'Project_cameraProfileId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @project_camera_profile_fk_exists = 0,
  'ALTER TABLE `Project` ADD CONSTRAINT `Project_cameraProfileId_fkey` FOREIGN KEY (`cameraProfileId`) REFERENCES `CameraProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @asset_camera_profile_fk_exists := (
  SELECT COUNT(1)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'Asset'
    AND constraint_name = 'Asset_cameraProfileId_fkey'
    AND constraint_type = 'FOREIGN KEY'
);
SET @sql := IF(
  @asset_camera_profile_fk_exists = 0,
  'ALTER TABLE `Asset` ADD CONSTRAINT `Asset_cameraProfileId_fkey` FOREIGN KEY (`cameraProfileId`) REFERENCES `CameraProfile`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
