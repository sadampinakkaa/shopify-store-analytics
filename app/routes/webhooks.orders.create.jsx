import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`[Store Analytics Webhook] Received ${topic} for ${shop}`);

  if (!payload || !shop) {
    return new Response();
  }

  try {
    const createdAtStr = payload.created_at || new Date().toISOString();
    const dayDate = new Date(`${createdAtStr.slice(0, 10)}T00:00:00.000Z`);

    const gross = parseFloat(payload.total_price || 0);
    const net = parseFloat(payload.subtotal_price || 0);
    let units = 0;
    for (const item of payload.line_items || []) {
      units += item.quantity || 0;
    }

    // Ensure store exists
    await prisma.store.upsert({
      where: { shop },
      create: { shop },
      update: {},
    });

    // Upsert SalesSnapshot for this day
    const existing = await prisma.salesSnapshot.findUnique({
      where: {
        shop_date: {
          shop,
          date: dayDate,
        },
      },
    });

    if (existing) {
      const nextGross = Math.round((existing.grossSales + gross) * 100) / 100;
      const nextNet = Math.round((existing.netSales + net) * 100) / 100;
      const nextOrders = existing.orders + 1;
      const nextUnits = existing.unitsSold + units;
      const nextAov = nextOrders > 0 ? Math.round((nextGross / nextOrders) * 100) / 100 : 0;

      await prisma.salesSnapshot.update({
        where: {
          shop_date: {
            shop,
            date: dayDate,
          },
        },
        data: {
          grossSales: nextGross,
          netSales: nextNet,
          orders: nextOrders,
          unitsSold: nextUnits,
          aov: nextAov,
        },
      });
    } else {
      await prisma.salesSnapshot.create({
        data: {
          shop,
          date: dayDate,
          grossSales: gross,
          netSales: net,
          orders: 1,
          unitsSold: units,
          aov: gross,
          newCustomers: 1,
          returning: 0,
        },
      });
    }
  } catch (err) {
    console.error("[Store Analytics Webhook] Error processing orders/create:", err);
  }

  return new Response();
};
