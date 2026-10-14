import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getPeriodDates,
  computeSalesAnalytics,
  computeProductIntelligence,
  computeInventoryIntelligence,
} from "../app/services/analytics.server.js";

describe("Analytics Service — Period Dates", () => {
  it("computes current and previous period date boundaries accurately", () => {
    const dates7d = getPeriodDates("-7d");
    assert.equal(dates7d.days, 7);
    assert.ok(dates7d.currentStartDate);
    assert.ok(dates7d.previousStartDate);
    assert.ok(new Date(dates7d.previousStartDate) < new Date(dates7d.currentStartDate));

    const dates30d = getPeriodDates("-30d");
    assert.equal(dates30d.days, 30);
  });
});

describe("Sales Analytics — Metrics, Trends, and Anomaly Detection", () => {
  const periodDates = {
    currentStartISO: "2026-10-01T00:00:00.000Z",
    previousStartISO: "2026-09-01T00:00:00.000Z",
  };

  const mockOrders = [
    // Previous period orders
    {
      id: "gid://shopify/Order/1",
      createdAt: "2026-09-15T10:00:00.000Z",
      totalPriceSet: { shopMoney: { amount: "100.00", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "90.00", currencyCode: "USD" } },
      lineItems: {
        edges: [{ node: { id: "1", quantity: 2, originalTotalSet: { shopMoney: { amount: "100.00" } } } }],
      },
    },
    // Current period orders
    {
      id: "gid://shopify/Order/2",
      createdAt: "2026-10-05T12:00:00.000Z",
      totalPriceSet: { shopMoney: { amount: "200.00", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "180.00", currencyCode: "USD" } },
      lineItems: {
        edges: [
          { node: { id: "2", quantity: 3, originalTotalSet: { shopMoney: { amount: "200.00" } } } },
        ],
      },
    },
    {
      id: "gid://shopify/Order/3",
      createdAt: "2026-10-06T14:30:00.000Z",
      totalPriceSet: { shopMoney: { amount: "300.00", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "270.00", currencyCode: "USD" } },
      lineItems: {
        edges: [
          { node: { id: "3", quantity: 4, originalTotalSet: { shopMoney: { amount: "300.00" } } } },
        ],
      },
    },
    {
      id: "gid://shopify/Order/4",
      createdAt: "2026-10-07T16:00:00.000Z",
      totalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
      subtotalPriceSet: { shopMoney: { amount: "10.00", currencyCode: "USD" } },
      lineItems: {
        edges: [
          { node: { id: "4", quantity: 1, originalTotalSet: { shopMoney: { amount: "10.00" } } } },
        ],
      },
    },
  ];

  it("calculates gross revenue, net sales, orders, units, and growth rates", () => {
    const result = computeSalesAnalytics(mockOrders, periodDates);
    // Current orders: Order 2 ($200), Order 3 ($300), Order 4 ($10) => Gross: $510
    assert.equal(result.kpi.grossSales, 510);
    // Net: $180 + $270 + $10 = $460
    assert.equal(result.kpi.netSales, 460);
    // Orders count: 3
    assert.equal(result.kpi.orders, 3);
    // Units sold: 3 + 4 + 1 = 8
    assert.equal(result.kpi.unitsSold, 8);
    // Average Order Value: $510 / 3 = $170
    assert.equal(result.kpi.aov, 170);
    // Revenue growth: Previous was $100, current is $510 => +410%
    assert.equal(result.kpi.revenueGrowth, 410);
    // Order growth: Previous was 1, current is 3 => +200%
    assert.equal(result.kpi.orderGrowth, 200);
  });

  it("generates daily trend rows with proper dates and amounts", () => {
    const result = computeSalesAnalytics(mockOrders, periodDates);
    assert.equal(result.trendRows.length, 3);
    assert.equal(result.trendRows[0].day, "2026-10-05");
    assert.equal(result.trendRows[0].gross_sales, 200);
    assert.equal(result.trendRows[1].day, "2026-10-06");
    assert.equal(result.trendRows[1].gross_sales, 300);
    assert.equal(result.trendRows[2].day, "2026-10-07");
    assert.equal(result.trendRows[2].gross_sales, 10);
  });

  it("calculates day-of-week breakdown and peak day", () => {
    const result = computeSalesAnalytics(mockOrders, periodDates);
    assert.equal(result.dayOfWeekBreakdown.length, 7);
    assert.ok(result.summary.peakDay);
    assert.equal(result.summary.peakDay.gross_sales, 300);
  });

  it("detects revenue plunge anomaly when a day drops significantly below average", () => {
    const result = computeSalesAnalytics(mockOrders, periodDates);
    // Average daily sales is $510 / 3 = $170.
    // On Oct 7, sales were $10, which is > 90% below average.
    const dip = result.anomalies.find((a) => a.type === "REVENUE_DIP");
    assert.ok(dip, "Should have flagged a revenue dip anomaly");
    assert.equal(dip.date, "2026-10-07");
  });
});

describe("Product Intelligence — Velocity, Classification, and Stockout Risks", () => {
  const mockProducts = [
    {
      id: "gid://shopify/Product/101",
      title: "Fast Seller T-Shirt",
      totalInventory: 14, // sells 7/wk => 14 days of supply remaining => Stockout Risk!
      variants: { edges: [{ node: { price: "25.00" } }] },
      featuredMedia: null,
    },
    {
      id: "gid://shopify/Product/102",
      title: "Dead Stock Denim Jacket",
      totalInventory: 50, // 0 sales => Dead Stock! Trapped capital: 50 * $80 = $4,000
      variants: { edges: [{ node: { price: "80.00" } }] },
      featuredMedia: null,
    },
    {
      id: "gid://shopify/Product/103",
      title: "Out of Stock Hoodie",
      totalInventory: 0, // 0 inventory => Out of Stock!
      variants: { edges: [{ node: { price: "60.00" } }] },
      featuredMedia: null,
    },
    {
      id: "gid://shopify/Product/104",
      title: "Healthy Seller Sneakers",
      totalInventory: 200, // sells 10/wk => ~140 days of supply
      variants: { edges: [{ node: { price: "120.00" } }] },
      featuredMedia: null,
    },
  ];

  const mockOrders = [
    {
      id: "gid://shopify/Order/1",
      createdAt: new Date().toISOString(),
      totalPriceSet: { shopMoney: { amount: "175.00" } },
      subtotalPriceSet: { shopMoney: { amount: "175.00" } },
      lineItems: {
        edges: [
          {
            node: {
              id: "item1",
              quantity: 7, // 7 units in 30 days = 0.233/day = ~1.63/wk
              originalTotalSet: { shopMoney: { amount: "175.00" } },
              product: { id: "gid://shopify/Product/101" },
            },
          },
        ],
      },
    },
    {
      id: "gid://shopify/Order/2",
      createdAt: new Date().toISOString(),
      totalPriceSet: { shopMoney: { amount: "600.00" } },
      subtotalPriceSet: { shopMoney: { amount: "600.00" } },
      lineItems: {
        edges: [
          {
            node: {
              id: "item2",
              quantity: 5,
              originalTotalSet: { shopMoney: { amount: "600.00" } },
              product: { id: "gid://shopify/Product/104" },
            },
          },
        ],
      },
    },
  ];

  it("classifies products into Healthy, Dead Stock, Out of Stock, and Stockout Risk", () => {
    const intelligence = computeProductIntelligence(mockProducts, mockOrders, 30);
    const p101 = intelligence.allProducts.find((p) => p.id === "gid://shopify/Product/101");
    const p102 = intelligence.allProducts.find((p) => p.id === "gid://shopify/Product/102");
    const p103 = intelligence.allProducts.find((p) => p.id === "gid://shopify/Product/103");
    const p104 = intelligence.allProducts.find((p) => p.id === "gid://shopify/Product/104");

    assert.equal(p102.velocityStatus, "Dead Stock");
    assert.equal(p102.urgency, "DEAD_STOCK");
    assert.equal(p102.stockValue, 4000); // 50 * $80

    assert.equal(p103.velocityStatus, "Out of Stock");
    assert.equal(p103.urgency, "OUT_OF_STOCK");

    assert.ok(p101.velocity > 0);
    assert.ok(p104.velocity > 0);
  });

  it("accurately calculates trapped dead stock capital", () => {
    const intelligence = computeProductIntelligence(mockProducts, mockOrders, 30);
    assert.equal(intelligence.deadStock.length, 1);
    assert.equal(intelligence.deadStock[0].stockValue, 4000);
    assert.equal(intelligence.stats.deadStockCapital, 4000);
  });

  it("ranks best sellers by revenue", () => {
    const intelligence = computeProductIntelligence(mockProducts, mockOrders, 30);
    assert.ok(intelligence.bestSellers.length >= 2);
    // Sneakers ($600) should be ranked higher than T-Shirt ($175)
    assert.equal(intelligence.bestSellers[0].id, "gid://shopify/Product/104");
    assert.equal(intelligence.bestSellers[0].revenue, 600);
    assert.equal(intelligence.bestSellers[1].id, "gid://shopify/Product/101");
    assert.equal(intelligence.bestSellers[1].revenue, 175);
  });

  it("calculates inventory intelligence summary properly", () => {
    const inv = computeInventoryIntelligence(mockProducts, mockOrders, 30);
    assert.equal(inv.summary.totalSkus, 4);
    assert.equal(inv.summary.outOfStockCount, 1);
    assert.equal(inv.summary.deadStockCount, 1);
    assert.equal(inv.summary.deadStockValue, 4000);
  });
});
