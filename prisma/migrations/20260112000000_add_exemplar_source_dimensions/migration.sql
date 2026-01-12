-- Add source image dimensions for exemplar scaling
ALTER TABLE `BatchJob`
    ADD COLUMN `exemplarSourceWidth` INTEGER NULL,
    ADD COLUMN `exemplarSourceHeight` INTEGER NULL;
