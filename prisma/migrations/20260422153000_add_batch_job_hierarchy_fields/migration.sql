ALTER TABLE `BatchJob`
    ADD COLUMN `parentBatchJobId` VARCHAR(191) NULL,
    ADD COLUMN `kind` VARCHAR(191) NOT NULL DEFAULT 'SINGLE',
    ADD COLUMN `shardIndex` INTEGER NULL,
    ADD COLUMN `shardCount` INTEGER NULL;

CREATE INDEX `BatchJob_parentBatchJobId_idx` ON `BatchJob`(`parentBatchJobId`);
CREATE INDEX `BatchJob_kind_idx` ON `BatchJob`(`kind`);

ALTER TABLE `BatchJob`
    ADD CONSTRAINT `BatchJob_parentBatchJobId_fkey`
    FOREIGN KEY (`parentBatchJobId`) REFERENCES `BatchJob`(`id`)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
