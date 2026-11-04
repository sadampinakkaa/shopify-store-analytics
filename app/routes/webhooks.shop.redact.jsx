import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "[Store Analytics Webhook] Authentication failed for shop/redact:",
      error?.message || error
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const { shop, topic, payload } = webhook;
  console.log(`[Store Analytics Compliance] Received ${topic} for ${shop}`);

  // 48 hours after uninstall, Shopify requires all store-related data to be redacted/purged.
  const targetShop = shop || payload?.shop_domain;

  if (targetShop) {
    try {
      await prisma.auditLog.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.subscription.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.scanResult.deleteMany({ where: { scan: { shop: targetShop } } }).catch(() => {});
      await prisma.problem.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.scan.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.productSnapshot.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.salesSnapshot.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.performanceTest.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.themeScan.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.theme.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.session.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      await prisma.store.deleteMany({ where: { shop: targetShop } }).catch(() => {});
      console.log(`[Store Analytics Compliance] Purged store data for ${targetShop}`);
    } catch (err) {
      console.error(`[Store Analytics Compliance] Error deleting shop data for ${targetShop}:`, err);
    }
  }

  return new Response("OK", { status: 200 });
};
