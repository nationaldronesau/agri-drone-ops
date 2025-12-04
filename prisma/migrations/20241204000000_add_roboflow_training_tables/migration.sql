-- CreateTable
CREATE TABLE `RoboflowProject` (
    `id` VARCHAR(191) NOT NULL,
    `roboflowId` VARCHAR(191) NOT NULL,
    `workspaceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `annotation` VARCHAR(191) NULL,
    `imageCount` INTEGER NOT NULL DEFAULT 0,
    `lastSyncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `RoboflowProject_roboflowId_key`(`roboflowId`),
    INDEX `RoboflowProject_roboflowId_idx`(`roboflowId`),
    INDEX `RoboflowProject_workspaceId_idx`(`workspaceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RoboflowClass` (
    `id` VARCHAR(191) NOT NULL,
    `projectId` VARCHAR(191) NOT NULL,
    `className` VARCHAR(191) NOT NULL,
    `color` VARCHAR(191) NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RoboflowClass_projectId_idx`(`projectId`),
    UNIQUE INDEX `RoboflowClass_projectId_className_key`(`projectId`, `className`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TrainingSession` (
    `id` VARCHAR(191) NOT NULL,
    `roboflowProjectId` VARCHAR(191) NOT NULL,
    `workflowType` ENUM('NEW_SPECIES', 'IMPROVE_EXISTING') NOT NULL,
    `status` ENUM('IN_PROGRESS', 'READY_TO_PUSH', 'PUSHING', 'COMPLETED', 'FAILED') NOT NULL DEFAULT 'IN_PROGRESS',
    `imagesTotal` INTEGER NOT NULL DEFAULT 0,
    `imagesLabeled` INTEGER NOT NULL DEFAULT 0,
    `annotationsCreated` INTEGER NOT NULL DEFAULT 0,
    `annotationsPushed` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `pushedAt` DATETIME(3) NULL,

    INDEX `TrainingSession_roboflowProjectId_idx`(`roboflowProjectId`),
    INDEX `TrainingSession_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AlterTable: Add training columns to ManualAnnotation
ALTER TABLE `ManualAnnotation`
    ADD COLUMN `pushedToTraining` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `pushedAt` DATETIME(3) NULL,
    ADD COLUMN `roboflowImageId` VARCHAR(191) NULL,
    ADD COLUMN `roboflowProjectId` VARCHAR(191) NULL,
    ADD COLUMN `roboflowClassName` VARCHAR(191) NULL,
    ADD COLUMN `trainingSessionId` VARCHAR(191) NULL;

-- CreateIndex
CREATE INDEX `ManualAnnotation_pushedToTraining_idx` ON `ManualAnnotation`(`pushedToTraining`);
CREATE INDEX `ManualAnnotation_roboflowProjectId_idx` ON `ManualAnnotation`(`roboflowProjectId`);
CREATE INDEX `ManualAnnotation_trainingSessionId_idx` ON `ManualAnnotation`(`trainingSessionId`);

-- AddForeignKey
ALTER TABLE `RoboflowClass` ADD CONSTRAINT `RoboflowClass_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `RoboflowProject`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TrainingSession` ADD CONSTRAINT `TrainingSession_roboflowProjectId_fkey` FOREIGN KEY (`roboflowProjectId`) REFERENCES `RoboflowProject`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ManualAnnotation` ADD CONSTRAINT `ManualAnnotation_trainingSessionId_fkey` FOREIGN KEY (`trainingSessionId`) REFERENCES `TrainingSession`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
