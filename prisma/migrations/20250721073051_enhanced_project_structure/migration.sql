-- AlterTable
ALTER TABLE "Asset" ADD COLUMN "flightDate" DATETIME;
ALTER TABLE "Asset" ADD COLUMN "flightSession" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "teamId" TEXT NOT NULL,
    "location" TEXT,
    "purpose" TEXT NOT NULL DEFAULT 'WEED_DETECTION',
    "season" TEXT,
    "centerLat" REAL,
    "centerLon" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Project" ("createdAt", "description", "id", "name", "teamId", "updatedAt") SELECT "createdAt", "description", "id", "name", "teamId", "updatedAt" FROM "Project";
DROP TABLE "Project";
ALTER TABLE "new_Project" RENAME TO "Project";
CREATE INDEX "Project_teamId_idx" ON "Project"("teamId");
CREATE INDEX "Project_location_idx" ON "Project"("location");
CREATE INDEX "Project_purpose_season_idx" ON "Project"("purpose", "season");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Asset_flightSession_idx" ON "Asset"("flightSession");
