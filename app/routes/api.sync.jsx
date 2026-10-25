import { authenticate } from "../shopify.server";
import {
  syncStoreSalesHistory,
  syncStoreCatalogSnapshots,
  runBackgroundScan,
  getStoreSyncStatus,
} from "../services/sync.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const status = await getStoreSyncStatus(session.shop);
  return Response.json(status);
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  try {
    if (intent === "sync_sales") {
      const days = parseInt(formData.get("days") || "30", 10);
      const result = await syncStoreSalesHistory(admin, session.shop, days);
      return Response.json({
        success: true,
        message: `Synced ${result.ordersSynced} orders across ${result.daysSynced} days.`,
        data: result,
      });
    }

    if (intent === "sync_catalog") {
      const result = await syncStoreCatalogSnapshots(admin, session.shop);
      return Response.json({
        success: true,
        message: `Cached ${result.productsSynced} product snapshots.`,
        data: result,
      });
    }

    if (intent === "sync_all") {
      const salesResult = await syncStoreSalesHistory(admin, session.shop, 30);
      const catalogResult = await syncStoreCatalogSnapshots(admin, session.shop);
      const scanResult = await runBackgroundScan(admin, session.shop);

      return Response.json({
        success: true,
        message: `Full store sync complete: ${salesResult.ordersSynced} orders, ${catalogResult.productsSynced} products, Health Score: ${scanResult.healthScore}/100.`,
      });
    }

    if (intent === "background_scan") {
      const result = await runBackgroundScan(admin, session.shop);
      return Response.json({
        success: true,
        message: `Diagnostics scan finished with Health Score: ${result.healthScore}/100.`,
        data: result,
      });
    }

    return Response.json({ success: false, error: "Invalid sync intent." }, { status: 400 });
  } catch (err) {
    return Response.json({ success: false, error: err.message || "Sync failed." }, { status: 500 });
  }
};
