-- Add per-project YOLO inference settings
ALTER TABLE `Project`
    ADD COLUMN `activeModelId` VARCHAR(191) NULL,
    ADD COLUMN `autoInferenceEnabled` BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX `Project_activeModelId_idx` ON `Project`(`activeModelId`);

-- AddForeignKey
ALTER TABLE `Project` ADD CONSTRAINT `Project_activeModelId_fkey` FOREIGN KEY (`activeModelId`) REFERENCES `TrainedModel`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
