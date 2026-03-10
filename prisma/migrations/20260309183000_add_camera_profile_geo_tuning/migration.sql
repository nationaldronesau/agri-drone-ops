-- Add per-camera georeferencing tuning knobs.
-- Idempotent to handle partial/manual schema states.

SET @camera_profile_fov_scale_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND column_name = 'fovScale'
);
SET @sql := IF(
  @camera_profile_fov_scale_col_exists = 0,
  'ALTER TABLE `CameraProfile` ADD COLUMN `fovScale` DOUBLE NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @camera_profile_altitude_scale_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND column_name = 'altitudeScale'
);
SET @sql := IF(
  @camera_profile_altitude_scale_col_exists = 0,
  'ALTER TABLE `CameraProfile` ADD COLUMN `altitudeScale` DOUBLE NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @camera_profile_yaw_offset_col_exists := (
  SELECT COUNT(1)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'CameraProfile'
    AND column_name = 'yawOffsetDeg'
);
SET @sql := IF(
  @camera_profile_yaw_offset_col_exists = 0,
  'ALTER TABLE `CameraProfile` ADD COLUMN `yawOffsetDeg` DOUBLE NULL',
  'SELECT 1'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
