-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "type" TEXT NOT NULL DEFAULT 'full',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "progress" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Scan_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ScanResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scanId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScanResult_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Problem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "scanId" TEXT,
    "severity" TEXT NOT NULL,
    "fixType" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "whyItMatters" TEXT NOT NULL,
    "resourceId" TEXT,
    "resourceType" TEXT,
    "resourceUrl" TEXT,
    "resolvedAt" DATETIME,
    "ignoredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Problem_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Problem_scanId_fkey" FOREIGN KEY ("scanId") REFERENCES "Scan" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProductSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "totalVariants" INTEGER NOT NULL,
    "totalInventory" INTEGER NOT NULL,
    "hasMedia" BOOLEAN NOT NULL,
    "hasDescription" BOOLEAN NOT NULL,
    "priceMin" REAL NOT NULL,
    "priceMax" REAL NOT NULL,
    "snapshotDate" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProductSnapshot_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SalesSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "grossSales" REAL NOT NULL DEFAULT 0,
    "netSales" REAL NOT NULL DEFAULT 0,
    "orders" INTEGER NOT NULL DEFAULT 0,
    "unitsSold" INTEGER NOT NULL DEFAULT 0,
    "aov" REAL NOT NULL DEFAULT 0,
    "newCustomers" INTEGER NOT NULL DEFAULT 0,
    "returning" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesSnapshot_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PerformanceTest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "pageType" TEXT NOT NULL,
    "pageUrl" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "lcp" REAL,
    "inp" REAL,
    "cls" REAL,
    "loadTime" REAL,
    "pageSize" INTEGER,
    "requestCount" INTEGER,
    "jsSize" INTEGER,
    "cssSize" INTEGER,
    "imageSize" INTEGER,
    "thirdParty" INTEGER,
    "testedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PerformanceTest_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Theme" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Theme_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThemeScan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "themeId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "liquidIssues" INTEGER NOT NULL DEFAULT 0,
    "jsIssues" INTEGER NOT NULL DEFAULT 0,
    "cssIssues" INTEGER NOT NULL DEFAULT 0,
    "assetIssues" INTEGER NOT NULL DEFAULT 0,
    "ghostScripts" INTEGER NOT NULL DEFAULT 0,
    "rawResults" TEXT,
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThemeScan_shop_fkey" FOREIGN KEY ("shop") REFERENCES "Store" ("shop") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ThemeScan_themeId_fkey" FOREIGN KEY ("themeId") REFERENCES "Theme" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_shop_key" ON "Store"("shop");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shop_snapshotDate_idx" ON "ProductSnapshot"("shop", "snapshotDate");

-- CreateIndex
CREATE INDEX "ProductSnapshot_shopifyId_idx" ON "ProductSnapshot"("shopifyId");

-- CreateIndex
CREATE INDEX "SalesSnapshot_shop_date_idx" ON "SalesSnapshot"("shop", "date");

-- CreateIndex
CREATE UNIQUE INDEX "SalesSnapshot_shop_date_key" ON "SalesSnapshot"("shop", "date");

-- CreateIndex
CREATE INDEX "PerformanceTest_shop_pageType_testedAt_idx" ON "PerformanceTest"("shop", "pageType", "testedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Theme_shop_shopifyId_key" ON "Theme"("shop", "shopifyId");

-- CreateIndex
CREATE INDEX "ThemeScan_shop_themeId_idx" ON "ThemeScan"("shop", "themeId");
