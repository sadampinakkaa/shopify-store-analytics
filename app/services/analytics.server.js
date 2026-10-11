// ─── STORE ANALYTICS SERVICE LAYER ──────────────────────────────────────────
// Handles data aggregation, period-over-period comparisons, product velocity,
// inventory intelligence, and stockout risk calculations.

export function getPeriodDates(sinceExpr = "-30d") {
  const now = new Date();
  const match = String(sinceExpr).match(/-(\d+)d/);
  const days = match ? parseInt(match[1], 10) : 30;

  const currentStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const previousStart = new Date(now.getTime() - days * 2 * 24 * 60 * 60 * 1000);

  return {
    days,
    currentStartISO: currentStart.toISOString(),
    currentStartDate: currentStart.toISOString().split("T")[0],
    previousStartISO: previousStart.toISOString(),
    previousStartDate: previousStart.toISOString().split("T")[0],
    nowISO: now.toISOString(),
  };
}

export async function fetchStoreOrders(admin, sinceDate) {
  try {
    const res = await admin.graphql(
      `#graphql
      query storeOrdersFull($query: String!) {
        orders(first: 250, query: $query) {
          edges {
            node {
              id
              name
              createdAt
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              subtotalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              lineItems(first: 50) {
                edges {
                  node {
                    id
                    title
                    quantity
                    originalTotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    product {
                      id
                      title
                      totalInventory
                    }
                    variant {
                      id
                      title
                      price
                      sku
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      {
        variables: {
          query: `status:any created_at:>=${sinceDate}`,
        },
      }
    );
    const json = await res.json();
    return json.data?.orders?.edges?.map((e) => e.node) ?? [];
  } catch (err) {
    console.warn("Failed to query full orders with line items:", err.message);
    return [];
  }
}

export async function fetchStoreCatalog(admin) {
  try {
    const res = await admin.graphql(
      `#graphql
      query storeCatalogDetailed {
        products(first: 250, query: "status:active") {
          edges {
            node {
              id
              title
              status
              totalInventory
              createdAt
              featuredMedia {
                preview {
                  image {
                    url
                  }
                }
              }
              variants(first: 20) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    barcode
                    inventoryQuantity
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
      }`
    );
    const json = await res.json();
    return json.data?.products?.edges?.map((e) => e.node) ?? [];
  } catch (err) {
    console.warn("Failed to query catalog:", err.message);
    return [];
  }
}

// ─── SALES ANALYTICS CALCULATION ─────────────────────────────────────────────
export function computeSalesAnalytics(orders, periodDates) {
  const currentOrders = [];
  const previousOrders = [];

  const curStart = new Date(periodDates.currentStartISO).getTime();
  const prevStart = new Date(periodDates.previousStartISO).getTime();

  for (const order of orders) {
    const orderTime = new Date(order.createdAt).getTime();
    if (orderTime >= curStart) {
      currentOrders.push(order);
    } else if (orderTime >= prevStart && orderTime < curStart) {
      previousOrders.push(order);
    }
  }

  // Current period metrics
  let grossSales = 0;
  let netSales = 0;
  let unitsSold = 0;
  const dailyTrends = {};

  for (const o of currentOrders) {
    const gross = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    const net = parseFloat(o.subtotalPriceSet?.shopMoney?.amount || 0);
    grossSales += gross;
    netSales += net;

    for (const le of o.lineItems?.edges ?? []) {
      unitsSold += le.node.quantity || 0;
    }

    const day = o.createdAt ? o.createdAt.slice(0, 10) : "";
    if (day) {
      if (!dailyTrends[day]) {
        dailyTrends[day] = { day, gross_sales: 0, net_sales: 0, orders: 0, units: 0 };
      }
      dailyTrends[day].gross_sales += gross;
      dailyTrends[day].net_sales += net;
      dailyTrends[day].orders += 1;
      for (const le of o.lineItems?.edges ?? []) {
        dailyTrends[day].units += le.node.quantity || 0;
      }
    }
  }

  // Previous period metrics for growth calculation
  let prevGrossSales = 0;
  for (const o of previousOrders) {
    prevGrossSales += parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
  }

  const orderCount = currentOrders.length;
  const prevOrderCount = previousOrders.length;

  const aov = orderCount > 0 ? grossSales / orderCount : 0;
  const prevAov = prevOrderCount > 0 ? prevGrossSales / prevOrderCount : 0;

  const revenueGrowth =
    prevGrossSales > 0 ? ((grossSales - prevGrossSales) / prevGrossSales) * 100 : null;
  const orderGrowth =
    prevOrderCount > 0 ? ((orderCount - prevOrderCount) / prevOrderCount) * 100 : null;

  const trendRows = Object.keys(dailyTrends)
    .sort()
    .map((day) => ({
      day,
      gross_sales: Math.round(dailyTrends[day].gross_sales * 100) / 100,
      net_sales: Math.round(dailyTrends[day].net_sales * 100) / 100,
      orders: dailyTrends[day].orders,
      units: dailyTrends[day].units,
    }));

  return {
    kpi: {
      grossSales: Math.round(grossSales * 100) / 100,
      netSales: Math.round(netSales * 100) / 100,
      orders: orderCount,
      unitsSold,
      aov: Math.round(aov * 100) / 100,
      revenueGrowth: revenueGrowth != null ? Math.round(revenueGrowth * 10) / 10 : null,
      orderGrowth: orderGrowth != null ? Math.round(orderGrowth * 10) / 10 : null,
    },
    trendRows,
  };
}

// ─── PRODUCT INTELLIGENCE CALCULATION ─────────────────────────────────────────
export function computeProductIntelligence(products, orders, periodDays = 30) {
  const productPerformanceMap = {};
  const curStart = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).getTime();

  // Aggregate line item sales
  for (const o of orders) {
    const orderTime = new Date(o.createdAt).getTime();
    if (orderTime < curStart) continue;

    for (const le of o.lineItems?.edges ?? []) {
      const item = le.node;
      const pid = item.product?.id;
      if (!pid) continue;

      if (!productPerformanceMap[pid]) {
        productPerformanceMap[pid] = {
          ordersCount: 0,
          unitsSold: 0,
          revenue: 0,
          lastSoldAt: o.createdAt,
        };
      }

      productPerformanceMap[pid].ordersCount += 1;
      productPerformanceMap[pid].unitsSold += item.quantity || 0;
      productPerformanceMap[pid].revenue += parseFloat(
        item.originalTotalSet?.shopMoney?.amount || 0
      );

      if (
        !productPerformanceMap[pid].lastSoldAt ||
        new Date(o.createdAt) > new Date(productPerformanceMap[pid].lastSoldAt)
      ) {
        productPerformanceMap[pid].lastSoldAt = o.createdAt;
      }
    }
  }

  // Combine with full catalog
  const catalogProducts = products.map((p) => {
    const perf = productPerformanceMap[p.id] || {
      ordersCount: 0,
      unitsSold: 0,
      revenue: 0,
      lastSoldAt: null,
    };

    const inventory = p.totalInventory ?? 0;
    const velocity = perf.unitsSold / Math.max(periodDays, 1); // units per day
    const weeklyVelocity = velocity * 7;

    // Velocity classification (Healthy, Slow Moving, Very Slow, Dead Stock)
    let velocityStatus = "Healthy";
    if (inventory <= 0) {
      velocityStatus = "Out of Stock";
    } else if (perf.unitsSold === 0) {
      velocityStatus = "Dead Stock";
    } else {
      const daysOfSupply = velocity > 0 ? inventory / velocity : 999;
      if (daysOfSupply > 180) {
        velocityStatus = "Very Slow";
      } else if (daysOfSupply > 90) {
        velocityStatus = "Slow Moving";
      } else {
        velocityStatus = "Healthy";
      }
    }

    const firstPrice = parseFloat(p.variants?.edges?.[0]?.node?.price || 0);

    return {
      id: p.id,
      title: p.title,
      imageUrl: p.featuredMedia?.preview?.image?.url || null,
      inventory,
      price: firstPrice,
      orders: perf.ordersCount,
      unitsSold: perf.unitsSold,
      revenue: Math.round(perf.revenue * 100) / 100,
      velocity: Math.round(velocity * 100) / 100,
      weeklyVelocity: Math.round(weeklyVelocity * 100) / 100,
      lastSoldAt: perf.lastSoldAt,
      velocityStatus,
    };
  });

  // Best Sellers (sorted by revenue descending)
  const bestSellers = [...catalogProducts]
    .filter((p) => p.unitsSold > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 15);

  // Least Ordered (sorted by units sold ascending)
  const leastOrdered = [...catalogProducts]
    .sort((a, b) => a.unitsSold - b.unitsSold || b.inventory - a.inventory)
    .slice(0, 15);

  // Slow Moving / Dead Stock products
  const slowMoving = catalogProducts.filter(
    (p) => p.velocityStatus === "Slow Moving" || p.velocityStatus === "Very Slow" || p.velocityStatus === "Dead Stock"
  );

  return {
    allProducts: catalogProducts,
    bestSellers,
    leastOrdered,
    slowMoving,
  };
}

// ─── INVENTORY INTELLIGENCE CALCULATION ───────────────────────────────────────
export function computeInventoryIntelligence(products, orders, periodDays = 30) {
  const { allProducts } = computeProductIntelligence(products, orders, periodDays);

  let totalSkus = 0;
  let inStockCount = 0;
  let lowStockCount = 0;
  let outOfStockCount = 0;
  let deadStockValue = 0;

  const lowStockThreshold = 5;
  const stockoutRiskItems = [];
  const deadStockItems = [];
  const overstockItems = [];

  for (const p of allProducts) {
    totalSkus++;
    const inv = p.inventory;

    if (inv <= 0) {
      outOfStockCount++;
    } else {
      inStockCount++;
      if (inv <= lowStockThreshold) {
        lowStockCount++;
      }
    }

    // Stockout risk
    if (p.weeklyVelocity > 0 && inv > 0) {
      const weeksToStockout = inv / p.weeklyVelocity;
      if (weeksToStockout <= 4) {
        stockoutRiskItems.push({
          ...p,
          weeksToStockout: Math.round(weeksToStockout * 10) / 10,
          daysToStockout: Math.round(weeksToStockout * 7),
          urgency: weeksToStockout <= 1 ? "EMERGENCY" : weeksToStockout <= 2 ? "HIGH" : "MODERATE",
        });
      } else if (weeksToStockout > 16) {
        overstockItems.push({
          ...p,
          weeksOfSupply: Math.round(weeksToStockout * 10) / 10,
        });
      }
    }

    // Dead Stock
    if (p.velocityStatus === "Dead Stock" && inv > 0) {
      const value = inv * p.price;
      deadStockValue += value;
      deadStockItems.push({
        ...p,
        stockValue: Math.round(value * 100) / 100,
      });
    }
  }

  stockoutRiskItems.sort((a, b) => a.weeksToStockout - b.weeksToStockout);
  deadStockItems.sort((a, b) => b.stockValue - a.stockValue);
  overstockItems.sort((a, b) => b.weeksOfSupply - a.weeksOfSupply);

  return {
    summary: {
      totalSkus,
      inStockCount,
      lowStockCount,
      outOfStockCount,
      deadStockCount: deadStockItems.length,
      deadStockValue: Math.round(deadStockValue * 100) / 100,
      stockoutRiskCount: stockoutRiskItems.length,
    },
    stockoutRiskItems: stockoutRiskItems.slice(0, 20),
    deadStockItems: deadStockItems.slice(0, 20),
    overstockItems: overstockItems.slice(0, 20),
  };
}
