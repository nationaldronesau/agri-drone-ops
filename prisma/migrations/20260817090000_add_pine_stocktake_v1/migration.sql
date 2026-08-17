-- Pine Stocktake v1 keeps model predictions immutable and stores reviewer work separately.

CREATE TABLE `PineStocktakeJob` (
  `id` VARCHAR(191) NOT NULL,
  `projectId` VARCHAR(191) NOT NULL,
  `teamId` VARCHAR(191) NOT NULL,
  `orthomosaicId` VARCHAR(191) NULL,
  `createdById` VARCHAR(191) NOT NULL,
  `methodVersion` VARCHAR(191) NOT NULL DEFAULT 'pine-stocktake-v1',
  `modelRepository` VARCHAR(191) NOT NULL,
  `modelRevision` VARCHAR(191) NOT NULL,
  `modelWeightSha256` VARCHAR(191) NOT NULL,
  `modelConfig` JSON NOT NULL,
  `immutableManifest` JSON NOT NULL,
  `immutableManifestSha256` VARCHAR(191) NOT NULL,
  `runnerPath` VARCHAR(191) NULL,
  `runnerCommit` VARCHAR(191) NULL,
  `runnerTreeSha256` VARCHAR(191) NULL,
  `targetCrs` VARCHAR(191) NULL,
  `poseTimebase` VARCHAR(191) NULL,
  `status` ENUM('DRAFT','QUEUED','PROCESSING','REVIEW_REQUIRED','COMPLETED','FAILED','BLOCKED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
  `stage` ENUM('UPLOAD_VALIDATE','EXEMPLARS_DETECT','REVIEW_CROWNS','MAP_HEIGHT_EXPORT') NOT NULL DEFAULT 'UPLOAD_VALIDATE',
  `progress` INTEGER NOT NULL DEFAULT 0,
  `counters` JSON NULL,
  `restartState` JSON NULL,
  `failureReason` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL,
  `startedAt` DATETIME(3) NULL,
  `completedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `PineStocktakeJob_projectId_status_idx` (`projectId`, `status`),
  INDEX `PineStocktakeJob_teamId_idx` (`teamId`),
  INDEX `PineStocktakeJob_orthomosaicId_idx` (`orthomosaicId`),
  INDEX `PineStocktakeJob_createdById_idx` (`createdById`),
  INDEX `PineStocktakeJob_stage_status_idx` (`stage`, `status`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineMissionFile` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL,
  `kind` ENUM('IMAGE_LV','IMAGE_RV','CLC','CLI','MRK','RPOS','POSE_EQUIVALENT','LIDAR_LAS','LIDAR_LAZ','CAMERA_METADATA') NOT NULL,
  `assetId` VARCHAR(191) NULL, `fileName` VARCHAR(191) NOT NULL, `sha256` VARCHAR(191) NOT NULL,
  `cameraSerial` VARCHAR(191) NULL, `poseIdentity` VARCHAR(191) NULL, `timebase` VARCHAR(191) NULL, `crs` VARCHAR(191) NULL,
  `metadata` JSON NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE INDEX `PineMissionFile_jobId_kind_fileName_key` (`jobId`,`kind`,`fileName`),
  INDEX `PineMissionFile_jobId_kind_idx` (`jobId`,`kind`), INDEX `PineMissionFile_assetId_idx` (`assetId`), INDEX `PineMissionFile_sha256_idx` (`sha256`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineExemplar` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `sourceAssetId` VARCHAR(191) NOT NULL,
  `sourceImageSha256` VARCHAR(191) NOT NULL, `nativePolygon` JSON NOT NULL, `exemplarSha256` VARCHAR(191) NOT NULL,
  `approved` BOOLEAN NOT NULL DEFAULT false, `approvedById` VARCHAR(191) NULL, `approvedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineExemplar_jobId_exemplarSha256_key` (`jobId`,`exemplarSha256`),
  INDEX `PineExemplar_jobId_approved_idx` (`jobId`,`approved`), INDEX `PineExemplar_sourceAssetId_idx` (`sourceAssetId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineInferenceRun` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `exemplarId` VARCHAR(191) NOT NULL, `targetAssetId` VARCHAR(191) NOT NULL,
  `idempotencyKey` VARCHAR(191) NOT NULL, `status` VARCHAR(191) NOT NULL, `nativeTileManifest` JSON NOT NULL,
  `modelResult` JSON NULL, `modelResultSha256` VARCHAR(191) NULL, `failureReason` VARCHAR(191) NULL, `attemptCount` INTEGER NOT NULL DEFAULT 0,
  `startedAt` DATETIME(3) NULL, `completedAt` DATETIME(3) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`), UNIQUE INDEX `PineInferenceRun_idempotencyKey_key` (`idempotencyKey`),
  UNIQUE INDEX `PineInferenceRun_jobId_exemplarId_targetAssetId_key` (`jobId`,`exemplarId`,`targetAssetId`),
  INDEX `PineInferenceRun_jobId_status_idx` (`jobId`,`status`), INDEX `PineInferenceRun_targetAssetId_idx` (`targetAssetId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineCandidate` (
  `id` VARCHAR(191) NOT NULL, `candidateId` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `inferenceRunId` VARCHAR(191) NOT NULL,
  `targetAssetId` VARCHAR(191) NOT NULL, `targetImageSha256` VARCHAR(191) NOT NULL, `exemplarId` VARCHAR(191) NOT NULL,
  `nativeTile` JSON NOT NULL, `nativePolygon` JSON NOT NULL, `nativeBbox` JSON NOT NULL, `maskEncoding` JSON NOT NULL,
  `score` DOUBLE NOT NULL, `modelResultSha256` VARCHAR(191) NOT NULL, `duplicateLineage` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineCandidate_jobId_candidateId_key` (`jobId`,`candidateId`), INDEX `PineCandidate_jobId_targetAssetId_idx` (`jobId`,`targetAssetId`),
  INDEX `PineCandidate_inferenceRunId_idx` (`inferenceRunId`), INDEX `PineCandidate_exemplarId_idx` (`exemplarId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineAgreementGroup` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `agreementId` VARCHAR(191) NOT NULL, `targetAssetId` VARCHAR(191) NOT NULL,
  `representativeCandidateId` VARCHAR(191) NOT NULL, `agreementLevel` INTEGER NOT NULL, `scoresByExemplar` JSON NOT NULL, `nativePolygon` JSON NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineAgreementGroup_jobId_agreementId_key` (`jobId`,`agreementId`),
  INDEX `PineAgreementGroup_jobId_agreementLevel_idx` (`jobId`,`agreementLevel`), INDEX `PineAgreementGroup_targetAssetId_idx` (`targetAssetId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineAgreementMember` (
  `agreementGroupId` VARCHAR(191) NOT NULL, `candidateId` VARCHAR(191) NOT NULL,
  PRIMARY KEY (`agreementGroupId`,`candidateId`), INDEX `PineAgreementMember_candidateId_idx` (`candidateId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineReviewRevision` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `candidateId` VARCHAR(191) NULL, `parentRevisionId` VARCHAR(191) NULL, `reviewerId` VARCHAR(191) NOT NULL,
  `nativePolygon` JSON NOT NULL, `action` VARCHAR(191) NOT NULL, `reviewState` VARCHAR(191) NOT NULL, `edgeClipped` BOOLEAN NOT NULL DEFAULT false,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  INDEX `PineReviewRevision_jobId_reviewState_createdAt_idx` (`jobId`,`reviewState`,`createdAt`), INDEX `PineReviewRevision_candidateId_createdAt_idx` (`candidateId`,`createdAt`), INDEX `PineReviewRevision_parentRevisionId_idx` (`parentRevisionId`),
  INDEX `PineReviewRevision_reviewerId_idx` (`reviewerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineAcceptedCrown` (
  `id` VARCHAR(191) NOT NULL, `crownId` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `candidateId` VARCHAR(191) NULL,
  `sourceAssetId` VARCHAR(191) NOT NULL, `sourceImageSha256` VARCHAR(191) NOT NULL, `nativePolygon` JSON NOT NULL,
  `contributingExemplarIds` JSON NOT NULL, `scoresByExemplar` JSON NOT NULL, `agreementLevel` INTEGER NOT NULL,
  `reviewerId` VARCHAR(191) NOT NULL, `reviewedAt` DATETIME(3) NOT NULL, `acceptedRevisionId` VARCHAR(191) NOT NULL,
  `revisionLineage` JSON NOT NULL, `edgeClipped` BOOLEAN NOT NULL DEFAULT false, `reviewState` VARCHAR(191) NOT NULL DEFAULT 'accepted',
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineAcceptedCrown_candidateId_key` (`candidateId`), UNIQUE INDEX `PineAcceptedCrown_acceptedRevisionId_key` (`acceptedRevisionId`),
  UNIQUE INDEX `PineAcceptedCrown_jobId_crownId_key` (`jobId`,`crownId`), INDEX `PineAcceptedCrown_jobId_reviewState_idx` (`jobId`,`reviewState`),
  INDEX `PineAcceptedCrown_sourceAssetId_idx` (`sourceAssetId`), INDEX `PineAcceptedCrown_reviewerId_idx` (`reviewerId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineDuplicateGroup` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `duplicateGroupId` VARCHAR(191) NOT NULL,
  `acceptedCrownIds` JSON NOT NULL, `observationLineage` JSON NOT NULL, `canonicalCrownId` VARCHAR(191) NOT NULL,
  `status` VARCHAR(191) NOT NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineDuplicateGroup_jobId_duplicateGroupId_key` (`jobId`,`duplicateGroupId`), INDEX `PineDuplicateGroup_jobId_canonicalCrownId_idx` (`jobId`,`canonicalCrownId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineFlatMapResult` (
  `id` VARCHAR(191) NOT NULL, `jobId` VARCHAR(191) NOT NULL, `runnerCommit` VARCHAR(191) NOT NULL, `runnerTreeSha256` VARCHAR(191) NOT NULL,
  `inputManifestSha256` VARCHAR(191) NOT NULL, `projectedCrs` VARCHAR(191) NOT NULL, `approximate` BOOLEAN NOT NULL DEFAULT true,
  `geotiffSha256` VARCHAR(191) NULL, `previewPngSha256` VARCHAR(191) NULL, `footprintsSha256` VARCHAR(191) NULL,
  `metadataCsvSha256` VARCHAR(191) NULL, `runSummarySha256` VARCHAR(191) NULL, `outputs` JSON NOT NULL,
  `status` VARCHAR(191) NOT NULL, `failureReason` VARCHAR(191) NULL, `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), `completedAt` DATETIME(3) NULL,
  PRIMARY KEY (`id`), UNIQUE INDEX `PineFlatMapResult_jobId_key` (`jobId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `PineLidarAssociation` (
  `id` VARCHAR(191) NOT NULL, `acceptedCrownId` VARCHAR(191) NOT NULL, `status` VARCHAR(191) NOT NULL, `method` VARCHAR(191) NOT NULL,
  `x` DOUBLE NULL, `y` DOUBLE NULL, `apexX` DOUBLE NULL, `apexY` DOUBLE NULL, `apexZ` DOUBLE NULL,
  `heightP99M` DOUBLE NULL, `heightMaxValidM` DOUBLE NULL, `localGroundZ` DOUBLE NULL, `matchConfidence` DOUBLE NULL,
  `vegetationPointIds` JSON NULL, `observationLineage` JSON NOT NULL, `missingReason` VARCHAR(191) NULL, `failureDetail` VARCHAR(191) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), PRIMARY KEY (`id`),
  UNIQUE INDEX `PineLidarAssociation_acceptedCrownId_key` (`acceptedCrownId`), INDEX `PineLidarAssociation_status_idx` (`status`),
  INDEX `PineLidarAssociation_missingReason_idx` (`missingReason`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `PineStocktakeJob` ADD CONSTRAINT `PineStocktakeJob_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `Project`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineStocktakeJob_teamId_fkey` FOREIGN KEY (`teamId`) REFERENCES `Team`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineStocktakeJob_orthomosaicId_fkey` FOREIGN KEY (`orthomosaicId`) REFERENCES `Orthomosaic`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PineStocktakeJob_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineMissionFile` ADD CONSTRAINT `PineMissionFile_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineMissionFile_assetId_fkey` FOREIGN KEY (`assetId`) REFERENCES `Asset`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `PineExemplar` ADD CONSTRAINT `PineExemplar_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineExemplar_sourceAssetId_fkey` FOREIGN KEY (`sourceAssetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineInferenceRun` ADD CONSTRAINT `PineInferenceRun_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineInferenceRun_exemplarId_fkey` FOREIGN KEY (`exemplarId`) REFERENCES `PineExemplar`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `PineInferenceRun_targetAssetId_fkey` FOREIGN KEY (`targetAssetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineCandidate` ADD CONSTRAINT `PineCandidate_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineCandidate_inferenceRunId_fkey` FOREIGN KEY (`inferenceRunId`) REFERENCES `PineInferenceRun`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `PineCandidate_targetAssetId_fkey` FOREIGN KEY (`targetAssetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineAgreementGroup` ADD CONSTRAINT `PineAgreementGroup_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `PineAgreementMember` ADD CONSTRAINT `PineAgreementMember_agreementGroupId_fkey` FOREIGN KEY (`agreementGroupId`) REFERENCES `PineAgreementGroup`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineAgreementMember_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `PineCandidate`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineReviewRevision` ADD CONSTRAINT `PineReviewRevision_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineReviewRevision_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `PineCandidate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PineReviewRevision_parentRevisionId_fkey` FOREIGN KEY (`parentRevisionId`) REFERENCES `PineReviewRevision`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PineReviewRevision_reviewerId_fkey` FOREIGN KEY (`reviewerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineAcceptedCrown` ADD CONSTRAINT `PineAcceptedCrown_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `PineAcceptedCrown_candidateId_fkey` FOREIGN KEY (`candidateId`) REFERENCES `PineCandidate`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `PineAcceptedCrown_sourceAssetId_fkey` FOREIGN KEY (`sourceAssetId`) REFERENCES `Asset`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `PineAcceptedCrown_reviewerId_fkey` FOREIGN KEY (`reviewerId`) REFERENCES `User`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT `PineAcceptedCrown_acceptedRevisionId_fkey` FOREIGN KEY (`acceptedRevisionId`) REFERENCES `PineReviewRevision`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `PineDuplicateGroup` ADD CONSTRAINT `PineDuplicateGroup_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `PineFlatMapResult` ADD CONSTRAINT `PineFlatMapResult_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `PineStocktakeJob`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE `PineLidarAssociation` ADD CONSTRAINT `PineLidarAssociation_acceptedCrownId_fkey` FOREIGN KEY (`acceptedCrownId`) REFERENCES `PineAcceptedCrown`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
