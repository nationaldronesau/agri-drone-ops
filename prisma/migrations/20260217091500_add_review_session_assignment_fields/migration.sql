-- AlterTable
ALTER TABLE `ReviewSession`
    ADD COLUMN `assignedToId` VARCHAR(191) NULL,
    ADD COLUMN `assignedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `ReviewSession_assignedToId_idx` ON `ReviewSession`(`assignedToId`);

-- AddForeignKey
ALTER TABLE `ReviewSession`
    ADD CONSTRAINT `ReviewSession_assignedToId_fkey`
    FOREIGN KEY (`assignedToId`) REFERENCES `User`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
