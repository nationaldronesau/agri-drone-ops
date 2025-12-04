-- AlterTable: Add review fields to Detection
ALTER TABLE `Detection`
    ADD COLUMN `reviewedAt` DATETIME(3) NULL,
    ADD COLUMN `reviewedBy` VARCHAR(191) NULL,
    ADD COLUMN `rejected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `userCorrected` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `originalClass` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Detection_verified_idx` ON `Detection`(`verified`);
CREATE INDEX `Detection_rejected_idx` ON `Detection`(`rejected`);
