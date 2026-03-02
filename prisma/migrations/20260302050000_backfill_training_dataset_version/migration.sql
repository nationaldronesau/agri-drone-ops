-- Backfill schema drift where TrainingDataset.version is missing in production.
-- This migration is idempotent:
-- 1) add version column if missing
-- 2) if the unique (projectId, version) index is missing, resequence versions per project
-- 3) recreate the missing unique index

SET @db := DATABASE();

SET @has_version_col := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.COLUMNS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'TrainingDataset'
    AND COLUMN_NAME = 'version'
);

SET @add_version_sql := IF(
  @has_version_col = 0,
  'ALTER TABLE `TrainingDataset` ADD COLUMN `version` INTEGER NULL',
  'SELECT 1'
);
PREPARE stmt FROM @add_version_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_unique_idx := (
  SELECT COUNT(*)
  FROM INFORMATION_SCHEMA.STATISTICS
  WHERE TABLE_SCHEMA = @db
    AND TABLE_NAME = 'TrainingDataset'
    AND INDEX_NAME = 'TrainingDataset_projectId_version_key'
);

SET @resequence_sql := IF(
  @has_unique_idx = 0,
  'UPDATE `TrainingDataset` td
   JOIN (
     SELECT
       `id`,
       ROW_NUMBER() OVER (
         PARTITION BY COALESCE(`projectId`, `id`)
         ORDER BY `createdAt` ASC, `id` ASC
       ) AS `seq`
     FROM `TrainingDataset`
   ) ranked ON ranked.`id` = td.`id`
   SET td.`version` = ranked.`seq`',
  'SELECT 1'
);
PREPARE stmt FROM @resequence_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @create_unique_sql := IF(
  @has_unique_idx = 0,
  'CREATE UNIQUE INDEX `TrainingDataset_projectId_version_key`
   ON `TrainingDataset`(`projectId`, `version`)',
  'SELECT 1'
);
PREPARE stmt FROM @create_unique_sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
