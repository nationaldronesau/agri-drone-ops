-- Backfill training schema drift observed in production after the YOLO tiling deploy.
-- Keep this migration idempotent because several training columns were added to
-- schema.prisma after the original training table migration was already applied.

SET @db := DATABASE();

-- TrainingDataset.displayName
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'displayName'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `displayName` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.snapshotAt
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'snapshotAt'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `snapshotAt` DATETIME(3) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.status
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'status'
);
SET @sql := IF(
  @has_col = 0,
  'ALTER TABLE `TrainingDataset` ADD COLUMN `status` ENUM(''CREATING'', ''READY'', ''TRAINING'', ''FAILED'', ''ARCHIVED'') NOT NULL DEFAULT ''READY''',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.preprocessingConfig
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'preprocessingConfig'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `preprocessingConfig` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.annotationManifestS3Key
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'annotationManifestS3Key'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `annotationManifestS3Key` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.annotationManifestChecksum
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'annotationManifestChecksum'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `annotationManifestChecksum` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.annotationCount
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'annotationCount'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `annotationCount` INTEGER NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.idempotencyKey
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'idempotencyKey'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `idempotencyKey` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND INDEX_NAME = 'TrainingDataset_idempotencyKey_key'
);
SET @sql := IF(
  @has_idx = 0,
  'CREATE UNIQUE INDEX `TrainingDataset_idempotencyKey_key` ON `TrainingDataset`(`idempotencyKey`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingDataset.creationFilters
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingDataset' AND COLUMN_NAME = 'creationFilters'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingDataset` ADD COLUMN `creationFilters` JSON NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- TrainingJob.checkpointModelId
SET @has_col := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingJob' AND COLUMN_NAME = 'checkpointModelId'
);
SET @sql := IF(@has_col = 0, 'ALTER TABLE `TrainingJob` ADD COLUMN `checkpointModelId` VARCHAR(191) NULL', 'SELECT 1');
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_idx := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db AND TABLE_NAME = 'TrainingJob' AND INDEX_NAME = 'TrainingJob_checkpointModelId_idx'
);
SET @sql := IF(
  @has_idx = 0,
  'CREATE INDEX `TrainingJob_checkpointModelId_idx` ON `TrainingJob`(`checkpointModelId`)',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_fk := (
  SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'TrainingJob'
    AND CONSTRAINT_NAME = 'TrainingJob_checkpointModelId_fkey'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @sql := IF(
  @has_fk = 0,
  'ALTER TABLE `TrainingJob` ADD CONSTRAINT `TrainingJob_checkpointModelId_fkey` FOREIGN KEY (`checkpointModelId`) REFERENCES `TrainedModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
