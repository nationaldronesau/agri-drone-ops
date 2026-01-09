-- AlterTable: Add custom model reference to Detection
ALTER TABLE `Detection`
    ADD COLUMN `customModelId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `Detection_customModelId_idx` ON `Detection`(`customModelId`);

-- AddForeignKey
ALTER TABLE `Detection` ADD CONSTRAINT `Detection_customModelId_fkey` FOREIGN KEY (`customModelId`) REFERENCES `TrainedModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
