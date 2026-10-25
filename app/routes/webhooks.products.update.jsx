import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[Store Analytics Webhook] Received ${topic} for ${shop}`);

  if (!payload || !shop) {
    return new Response();
  }

  try {
    const productId = `gid://shopify/Product/${payload.id}`;
    const title = payload.title || "Product";
    const status = (payload.status || "active").toUpperCase();
    const variants = payload.variants || [];

    let totalInventory = 0;
    for (const v of variants) {
      totalInventory += v.inventory_quantity || 0;
    }

    const problemId = `out-of-stock-${payload.id}`;

    // Ensure store exists
    await prisma.store.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });

    if (status === "ACTIVE" && totalInventory <= 0) {
      // Flag out-of-stock issue
      await prisma.problem.upsert({
        where: { id: problemId },
        create: {
          id: problemId,
          shop,
          severity: "CRITICAL",
          fixType: "APP_FIX",
          category: "inventory",
          title: "Active Product Out of Stock",
          description: `"${title}" is published and visible to shoppers but has 0 inventory in stock.`,
          whyItMatters: "Customers attempting to buy will encounter stockout friction or abandoned carts, hurting store conversion.",
          resourceId: productId,
          resourceType: "Product",
          resourceUrl: `https://${shop}/admin/products/${payload.id}`,
        },
        update: {
          resolvedAt: null,
          title: "Active Product Out of Stock",
          description: `"${title}" is published and visible to shoppers but has 0 inventory in stock.`,
        },
      });
    } else if (totalInventory > 0) {
      // Resolve any existing out-of-stock problem for this product
      await prisma.problem.updateMany({
        where: {
          id: problemId,
          shop,
          resolvedAt: null,
        },
        data: {
          resolvedAt: new Date(),
        },
      });
    }

    // Save product snapshot
    const prices = variants.map((v) => parseFloat(v.price || "0")).filter((p) => !isNaN(p));
    const priceMin = prices.length > 0 ? Math.min(...prices) : 0;
    const priceMax = prices.length > 0 ? Math.max(...prices) : 0;

    await prisma.productSnapshot.create({
      data: {
        shop,
        shopifyId: productId,
        title,
        status,
        totalVariants: variants.length,
        totalInventory,
        hasMedia: (payload.images && payload.images.length > 0) || false,
        hasDescription: Boolean(payload.body_html && payload.body_html.length > 20),
        priceMin,
        priceMax,
        snapshotDate: new Date(),
      },
    });
  } catch (err) {
    console.error("[Store Analytics Webhook] Error processing products/update:", err);
  }

  return new Response();
};
