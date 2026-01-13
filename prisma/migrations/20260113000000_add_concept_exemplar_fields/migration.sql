-- Add concept exemplar fields for SAM3 concept propagation
ALTER TABLE `BatchJob`
    ADD COLUMN `exemplarId` VARCHAR(191) NULL,
    ADD COLUMN `sourceAssetId` VARCHAR(191) NULL;

ALTER TABLE `PendingAnnotation`
    ADD COLUMN `similarity` DOUBLE NULL;
