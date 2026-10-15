import prisma from "../db.server.js";
import { fetchStoreOrders, fetchStoreCatalog, getPeriodDates, computeSalesAnalytics } from "./analytics.server.js";
import { runStoreScan } from "./scanner.server.js";

// ─── BACKGROUND SYNC & HISTORICAL SNAPSHOT SERVICE ────────────────────────────
// Handles background data extraction, snapshot persistence into SQLite,
// and automated synchronization for high-speed offline / cached rendering.

export async function syncStoreSalesHistory(admin, shop, days = 30) {
  const period = getPeriodDates(`-${days}d`);
  const orders = await fetchStoreOrders(admin, period.currentStartDate);

  // Group orders by day
  const dailyGroups = {};
  const customerCounts = {};

  for (const o of orders) {
    const cid = o.customer?.id;
    if (cid) customerCounts[cid] = (customerCounts[cid] || 0) + 1;
  }

  for (const o of orders) {
    const day = o.createdAt ? o.createdAt.slice(0, 10) : "";
    if (!day) continue;

    if (!dailyGroups[day]) {
      dailyGroups[day] = {
        date: new Date(`${day}T00:00:00.000Z`),
        grossSales: 0,
        netSales: 0,
        orders: 0,
        unitsSold: 0,
        newCustomers: 0,
        returning: 0,
      };
    }

    const gross = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    const net = parseFloat(o.subtotalPriceSet?.shopMoney?.amount || 0);
    dailyGroups[day].grossSales += gross;
    dailyGroups[day].netSales += net;
    dailyGroups[day].orders += 1;

    for (const le of o.lineItems?.edges ?? []) {
      dailyGroups[day].unitsSold += le.node.quantity || 0;
    }

    const cid = o.customer?.id;
    if (cid && (customerCounts[cid] || 0) > 1) {
      dailyGroups[day].returning += 1;
    } else {
      dailyGroups[day].newCustomers += 1;
    }
  }

  // Ensure Store record exists
  await prisma.store.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  let upsertCount = 0;
  for (const dayStr of Object.keys(dailyGroups)) {
    const data = dailyGroups[dayStr];
    const aov = data.orders > 0 ? Math.round((data.grossSales / data.orders) * 100) / 100 : 0;

    await prisma.salesSnapshot.upsert({
      where: {
        shop_date: {
          shop,
          date: data.date,
        },
      },
      create: {
        shop,
        date: data.date,
        grossSales: Math.round(data.grossSales * 100) / 100,
        netSales: Math.round(data.netSales * 100) / 100,
        orders: data.orders,
        unitsSold: data.unitsSold,
        aov,
        newCustomers: data.newCustomers,
        returning: data.returning,
      },
      update: {
        grossSales: Math.round(data.grossSales * 100) / 100,
        netSales: Math.round(data.netSales * 100) / 100,
        orders: data.orders,
        unitsSold: data.unitsSold,
        aov,
        newCustomers: data.newCustomers,
        returning: data.returning,
      },
    });
    upsertCount++;
  }

  await prisma.auditLog.create({
    data: {
      shop,
      action: "SALES_SYNC",
      resource: `${upsertCount} Daily Sales Snapshots`,
      details: `Successfully synced ${orders.length} orders across ${upsertCount} days into historical database.`,
    },
  });

  return {
    success: true,
    ordersSynced: orders.length,
    daysSynced: upsertCount,
    syncedAt: new Date().toISOString(),
  };
}

export async function syncStoreCatalogSnapshots(admin, shop) {
  const products = await fetchStoreCatalog(admin);

  // Ensure Store record exists
  await prisma.store.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  let snapshotCount = 0;
  const now = new Date();

  for (const p of products) {
    const variants = p.variants?.edges?.map((ve) => ve.node) ?? [];
    const prices = variants.map((v) => parseFloat(v.price || "0")).filter((pr) => !isNaN(pr));
    const priceMin = prices.length > 0 ? Math.min(...prices) : 0;
    const priceMax = prices.length > 0 ? Math.max(...prices) : 0;

    await prisma.productSnapshot.create({
      data: {
        shop,
        shopifyId: p.id,
        title: p.title,
        status: p.status || "ACTIVE",
        totalVariants: variants.length,
        totalInventory: p.totalInventory ?? 0,
        hasMedia: Boolean(p.featuredMedia?.preview?.image?.url),
        hasDescription: Boolean(p.descriptionHtml && p.descriptionHtml.length > 20),
        priceMin,
        priceMax,
        snapshotDate: now,
      },
    });
    snapshotCount++;
  }

  await prisma.auditLog.create({
    data: {
      shop,
      action: "CATALOG_SYNC",
      resource: `${snapshotCount} Products Cached`,
      details: `Saved ${snapshotCount} product snapshots for historical velocity and inventory trend reporting.`,
    },
  });

  return {
    success: true,
    productsSynced: snapshotCount,
    syncedAt: now.toISOString(),
  };
}

export async function runBackgroundScan(admin, shop, type = "full") {
  // Create scan record with pending status
  const scan = await prisma.scan.create({
    data: {
      shop,
      type,
      status: "running",
      progress: 25,
      startedAt: new Date(),
    },
  });

  try {
    const scanResult = await runStoreScan(admin, shop);

    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "complete",
        progress: 100,
        finishedAt: new Date(),
      },
    });

    return {
      success: true,
      scanId: scan.id,
      healthScore: scanResult.healthScore,
      problemsCount: scanResult.problems.length,
    };
  } catch (err) {
    await prisma.scan.update({
      where: { id: scan.id },
      data: {
        status: "failed",
        finishedAt: new Date(),
      },
    });
    throw err;
  }
}

export async function getStoreSyncStatus(shop) {
  try {
    const lastAudit = await prisma.auditLog.findFirst({
      where: { shop },
      orderBy: { createdAt: "desc" },
    });

    const salesSnapshotsCount = await prisma.salesSnapshot.count({
      where: { shop },
    });

    const activeProblemsCount = await prisma.problem.count({
      where: { shop, resolvedAt: null, ignoredAt: null },
    });

    const lastScan = await prisma.scan.findFirst({
      where: { shop },
      orderBy: { startedAt: "desc" },
    });

    return {
      lastSyncedAt: lastAudit?.createdAt || null,
      lastAction: lastAudit?.action || "None",
      salesSnapshotsCount,
      activeProblemsCount,
      lastScanStatus: lastScan?.status || "None",
      lastScanFinishedAt: lastScan?.finishedAt || null,
    };
  } catch {
    return {
      lastSyncedAt: null,
      lastAction: "None",
      salesSnapshotsCount: 0,
      activeProblemsCount: 0,
      lastScanStatus: "None",
      lastScanFinishedAt: null,
    };
  }
}
