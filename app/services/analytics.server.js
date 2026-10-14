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

  // Day of week accumulators: 0 (Sun) to 6 (Sat)
  const dayOfWeekMap = {
    0: { dayName: "Sunday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    1: { dayName: "Monday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    2: { dayName: "Tuesday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    3: { dayName: "Wednesday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    4: { dayName: "Thursday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    5: { dayName: "Friday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
    6: { dayName: "Saturday", gross_sales: 0, net_sales: 0, orders: 0, units: 0 },
  };

  for (const o of currentOrders) {
    const gross = parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    const net = parseFloat(o.subtotalPriceSet?.shopMoney?.amount || 0);
    grossSales += gross;
    netSales += net;

    let orderUnits = 0;
    for (const le of o.lineItems?.edges ?? []) {
      const q = le.node.quantity || 0;
      unitsSold += q;
      orderUnits += q;
    }

    const orderDate = new Date(o.createdAt);
    const day = o.createdAt ? o.createdAt.slice(0, 10) : "";
    if (day) {
      if (!dailyTrends[day]) {
        dailyTrends[day] = { day, gross_sales: 0, net_sales: 0, orders: 0, units: 0 };
      }
      dailyTrends[day].gross_sales += gross;
      dailyTrends[day].net_sales += net;
      dailyTrends[day].orders += 1;
      dailyTrends[day].units += orderUnits;
    }

    const dow = orderDate.getDay();
    if (dayOfWeekMap[dow]) {
      dayOfWeekMap[dow].gross_sales += gross;
      dayOfWeekMap[dow].net_sales += net;
      dayOfWeekMap[dow].orders += 1;
      dayOfWeekMap[dow].units += orderUnits;
    }
  }

  // Previous period metrics for growth calculation
  let prevGrossSales = 0;
  let prevNetSales = 0;
  let prevUnitsSold = 0;
  for (const o of previousOrders) {
    prevGrossSales += parseFloat(o.totalPriceSet?.shopMoney?.amount || 0);
    prevNetSales += parseFloat(o.subtotalPriceSet?.shopMoney?.amount || 0);
    for (const le of o.lineItems?.edges ?? []) {
      prevUnitsSold += le.node.quantity || 0;
    }
  }

  const orderCount = currentOrders.length;
  const prevOrderCount = previousOrders.length;

  const aov = orderCount > 0 ? grossSales / orderCount : 0;
  const prevAov = prevOrderCount > 0 ? prevGrossSales / prevOrderCount : 0;
  const itemsPerOrder = orderCount > 0 ? Math.round((unitsSold / orderCount) * 10) / 10 : 0;

  const revenueGrowth =
    prevGrossSales > 0 ? ((grossSales - prevGrossSales) / prevGrossSales) * 100 : null;
  const orderGrowth =
    prevOrderCount > 0 ? ((orderCount - prevOrderCount) / prevOrderCount) * 100 : null;
  const aovGrowth =
    prevAov > 0 ? ((aov - prevAov) / prevAov) * 100 : null;
  const unitsGrowth =
    prevUnitsSold > 0 ? ((unitsSold - prevUnitsSold) / prevUnitsSold) * 100 : null;

  const trendRows = Object.keys(dailyTrends)
    .sort()
    .map((day) => {
      const dGross = Math.round(dailyTrends[day].gross_sales * 100) / 100;
      const dNet = Math.round(dailyTrends[day].net_sales * 100) / 100;
      const dOrders = dailyTrends[day].orders;
      const dUnits = dailyTrends[day].units;
      const dAov = dOrders > 0 ? Math.round((dGross / dOrders) * 100) / 100 : 0;
      return {
        day,
        gross_sales: dGross,
        net_sales: dNet,
        orders: dOrders,
        units: dUnits,
        aov: dAov,
      };
    });

  // Calculate day-of-week array
  const dayOfWeekBreakdown = Object.keys(dayOfWeekMap).map((k) => {
    const item = dayOfWeekMap[k];
    const itemAov = item.orders > 0 ? Math.round((item.gross_sales / item.orders) * 100) / 100 : 0;
    const pctOfTotal = grossSales > 0 ? Math.round((item.gross_sales / grossSales) * 1000) / 10 : 0;
    return {
      dayIndex: parseInt(k, 10),
      dayName: item.dayName,
      gross_sales: Math.round(item.gross_sales * 100) / 100,
      net_sales: Math.round(item.net_sales * 100) / 100,
      orders: item.orders,
      units: item.units,
      aov: itemAov,
      pctOfTotal,
    };
  });

  // Identify peak day, slowest day, and daily average
  let peakDay = null;
  let lowestDay = null;
  if (trendRows.length > 0) {
    const sortedByRev = [...trendRows].sort((a, b) => b.gross_sales - a.gross_sales);
    peakDay = sortedByRev[0];
    const nonZeroDays = sortedByRev.filter((r) => r.gross_sales > 0);
    lowestDay = nonZeroDays.length > 0 ? nonZeroDays[nonZeroDays.length - 1] : sortedByRev[sortedByRev.length - 1];
  }

  const activeDaysCount = Math.max(trendRows.length, 1);
  const avgDailySales = Math.round((grossSales / activeDaysCount) * 100) / 100;
  const avgDailyOrders = Math.round((orderCount / activeDaysCount) * 10) / 10;

  // ── Sales Diagnostics & Anomaly Detection ──
  const anomalies = [];

  // 1. Significant Revenue Dip Detection
  if (avgDailySales > 20 && trendRows.length >= 3) {
    for (const r of trendRows) {
      if (r.gross_sales < avgDailySales * 0.4 && r.orders <= Math.max(1, Math.floor(avgDailyOrders * 0.4))) {
        const dropPct = Math.round(((avgDailySales - r.gross_sales) / avgDailySales) * 100);
        anomalies.push({
          id: `dip-${r.day}`,
          type: "REVENUE_DIP",
          severity: "WARNING",
          date: r.day,
          title: `Sales Plunge on ${r.day}`,
          description: `Revenue was $${r.gross_sales.toLocaleString()}, which is ${dropPct}% below your daily average of $${avgDailySales.toLocaleString()}.`,
          whyItMatters: "Sudden drops may signify advertising ad pause, traffic drop, or website friction.",
        });
      }
    }
  }

  // 2. High Discount / Return Gap Detection
  if (grossSales > 100 && netSales < grossSales * 0.8) {
    const discountPct = Math.round(((grossSales - netSales) / grossSales) * 100);
    anomalies.push({
      id: "discount-gap",
      type: "MARGIN_GAP",
      severity: "NOTICE",
      title: `High Discount / Return Variance (${discountPct}%)`,
      description: `Net sales ($${netSales.toLocaleString()}) are ${discountPct}% below gross sales ($${grossSales.toLocaleString()}).`,
      whyItMatters: "Heavy discounting or refund leakage directly reduces gross margins and store profitability.",
    });
  }

  // 3. Day of week imbalance detection
  const bestDay = [...dayOfWeekBreakdown].sort((a, b) => b.gross_sales - a.gross_sales)[0];
  const slowestActiveDay = [...dayOfWeekBreakdown].sort((a, b) => a.gross_sales - b.gross_sales)[0];

  return {
    kpi: {
      grossSales: Math.round(grossSales * 100) / 100,
      netSales: Math.round(netSales * 100) / 100,
      orders: orderCount,
      unitsSold,
      aov: Math.round(aov * 100) / 100,
      itemsPerOrder,
      revenueGrowth: revenueGrowth != null ? Math.round(revenueGrowth * 10) / 10 : null,
      orderGrowth: orderGrowth != null ? Math.round(orderGrowth * 10) / 10 : null,
      aovGrowth: aovGrowth != null ? Math.round(aovGrowth * 10) / 10 : null,
      unitsGrowth: unitsGrowth != null ? Math.round(unitsGrowth * 10) / 10 : null,
    },
    prevPeriod: {
      grossSales: Math.round(prevGrossSales * 100) / 100,
      netSales: Math.round(prevNetSales * 100) / 100,
      orders: prevOrderCount,
      unitsSold: prevUnitsSold,
      aov: Math.round(prevAov * 100) / 100,
    },
    trendRows,
    dayOfWeekBreakdown,
    summary: {
      avgDailySales,
      avgDailyOrders,
      peakDay,
      lowestDay,
      bestDayName: bestDay?.gross_sales > 0 ? bestDay.dayName : null,
      slowestDayName: slowestActiveDay?.dayName || null,
    },
    anomalies: anomalies.slice(0, 5),
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

      const q = item.quantity || 0;
      productPerformanceMap[pid].ordersCount += 1;
      productPerformanceMap[pid].unitsSold += q;

      const lineTotal = parseFloat(
        item.originalTotalSet?.shopMoney?.amount ||
        (parseFloat(item.variant?.price || 0) * q) ||
        0
      );
      productPerformanceMap[pid].revenue += lineTotal;

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
    const firstPrice = parseFloat(p.variants?.edges?.[0]?.node?.price || 0);
    const stockValue = Math.round(inventory * firstPrice * 100) / 100;

    // Days of supply remaining
    const daysOfSupply = velocity > 0 ? Math.round(inventory / velocity) : (inventory <= 0 ? 0 : 999);
    const weeksOfSupply = velocity > 0 ? Math.round((inventory / (velocity * 7)) * 10) / 10 : 999;

    // Velocity classification (Healthy, Slow Moving, Very Slow, Dead Stock, Out of Stock)
    let velocityStatus = "Healthy";
    let urgency = "HEALTHY";

    if (inventory <= 0) {
      velocityStatus = "Out of Stock";
      urgency = "OUT_OF_STOCK";
    } else if (perf.unitsSold === 0) {
      velocityStatus = "Dead Stock";
      urgency = "DEAD_STOCK";
    } else {
      if (daysOfSupply > 180) {
        velocityStatus = "Very Slow";
        urgency = "OVERSTOCK";
      } else if (daysOfSupply > 90) {
        velocityStatus = "Slow Moving";
        urgency = "SLOW";
      } else if (daysOfSupply <= 7) {
        velocityStatus = "Stockout Risk";
        urgency = "EMERGENCY";
      } else if (daysOfSupply <= 14) {
        velocityStatus = "Stockout Risk";
        urgency = "HIGH";
      } else if (daysOfSupply <= 30) {
        velocityStatus = "Stockout Risk";
        urgency = "MODERATE";
      } else {
        velocityStatus = "Healthy";
        urgency = "HEALTHY";
      }
    }

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
      daysOfSupply,
      weeksOfSupply,
      stockValue,
      urgency,
      lastSoldAt: perf.lastSoldAt,
      velocityStatus,
    };
  });

  // Best Sellers (sorted by revenue descending)
  const bestSellers = [...catalogProducts]
    .filter((p) => p.unitsSold > 0)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 20);

  // Least Ordered (sorted by units sold ascending, with inventory)
  const leastOrdered = [...catalogProducts]
    .sort((a, b) => a.unitsSold - b.unitsSold || b.inventory - a.inventory)
    .slice(0, 20);

  // Slow Moving / Dead Stock products
  const slowMoving = catalogProducts.filter(
    (p) =>
      p.velocityStatus === "Slow Moving" ||
      p.velocityStatus === "Very Slow" ||
      p.velocityStatus === "Dead Stock"
  );

  // Stockout Risk products (active sellers running low on inventory)
  const stockoutRisk = catalogProducts
    .filter((p) => p.velocity > 0 && p.inventory > 0 && p.daysOfSupply <= 30)
    .sort((a, b) => a.daysOfSupply - b.daysOfSupply);

  // Dead Stock products with capital tied up
  const deadStock = catalogProducts
    .filter((p) => p.velocityStatus === "Dead Stock" && p.inventory > 0)
    .sort((a, b) => b.stockValue - a.stockValue);

  const totalDeadStockCapital = Math.round(deadStock.reduce((acc, p) => acc + p.stockValue, 0) * 100) / 100;
  const potentialRevenueAtRisk = Math.round(stockoutRisk.reduce((acc, p) => acc + (p.weeklyVelocity * p.price * 2), 0) * 100) / 100;

  return {
    allProducts: catalogProducts,
    bestSellers,
    leastOrdered,
    slowMoving,
    stockoutRisk,
    deadStock,
    stats: {
      totalProducts: catalogProducts.length,
      activeSelling: bestSellers.length,
      slowMovingCount: slowMoving.length,
      deadStockCount: deadStock.length,
      deadStockCapital: totalDeadStockCapital,
      stockoutRiskCount: stockoutRisk.length,
      revenueAtRisk: potentialRevenueAtRisk,
      outOfStockCount: catalogProducts.filter((p) => p.inventory <= 0).length,
    },
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
