import { useState, useMemo, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getPeriodDates,
  fetchStoreOrders,
  fetchStoreCatalog,
  computeSalesAnalytics,
} from "../services/analytics.server";
import { runStoreScan } from "../services/scanner.server";
import { executeAppFix } from "../services/fixes.server";
import prisma from "../db.server";

const DATE_RANGES = [
  { label: "7D", sinceExpr: "-7d" },
  { label: "30D", sinceExpr: "-30d" },
  { label: "90D", sinceExpr: "-90d" },
  { label: "6M", sinceExpr: "-180d" },
  { label: "1Y", sinceExpr: "-365d" },
];

function fmtMoney(val) {
  if (val == null || isNaN(val)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);
}

function fmtNum(val) {
  if (val == null || isNaN(val)) return "0";
  return new Intl.NumberFormat("en-US").format(val);
}

// ─── LOADER ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const shop = session?.shop || "";

    const url = new URL(request.url);
    const since = url.searchParams.get("since") || "-30d";
    const periodDates = getPeriodDates(since);

    // 1. Fetch Orders & Calculate Sales Analytics
    let orders = [];
    try {
      orders = await fetchStoreOrders(admin, periodDates.previousStartDate);
    } catch (err) {
      console.warn("Orders fetch caught in dashboard loader:", err.message);
    }
    const salesAnalytics = computeSalesAnalytics(orders, periodDates);

    // 2. Fetch Catalog Snapshot
    let catalog = [];
    try {
      catalog = await fetchStoreCatalog(admin);
    } catch (err) {
      console.warn("Catalog fetch caught in dashboard loader:", err.message);
    }

    // 3. Retrieve or Execute Problem Diagnostic Scan
    let dbProblems = [];
    let resolvedCount = 0;
    try {
      dbProblems = await prisma.problem.findMany({
        where: { shop, resolvedAt: null },
        orderBy: { createdAt: "desc" },
      });
      resolvedCount = await prisma.problem.count({
        where: { shop, resolvedAt: { not: null } },
      });
    } catch (err) {
      console.warn("Database lookup caught in dashboard loader:", err.message);
    }

    // If no diagnostic problems in DB, run a scan safely
    let scanStats = null;
    let healthScore = 100;
    if (dbProblems.length === 0) {
      try {
        const scanResult = await runStoreScan(admin, shop);
        dbProblems = scanResult.problems || [];
        healthScore = scanResult.healthScore || 100;
        scanStats = scanResult.stats;
      } catch (scanErr) {
        console.warn("Auto-scan caught in dashboard loader:", scanErr.message);
      }
    }

    // Calculate health metrics
    const critCount = dbProblems.filter((p) => p.severity === "CRITICAL").length;
    const warnCount = dbProblems.filter((p) => p.severity === "WARNING").length;
    const notcCount = dbProblems.filter((p) => p.severity === "NOTICE").length;

    if (scanStats == null) {
      healthScore = Math.max(0, 100 - (critCount * 15 + warnCount * 5 + notcCount * 2));
      scanStats = {
        critical: critCount,
        warning: warnCount,
        notice: notcCount,
        total: dbProblems.length,
        resolved: resolvedCount,
      };
    }

    // Category breakdown
    const categoryCounts = {
      inventory: dbProblems.filter((p) => p.category === "inventory").length,
      product: dbProblems.filter((p) => p.category === "product").length,
      seo: dbProblems.filter((p) => p.category === "seo").length,
      performance: dbProblems.filter((p) => p.category === "performance").length,
    };

    // Customers calculation
    const customerCounts = {};
    for (const o of orders) {
      const cid = o.customer?.id;
      if (cid) customerCounts[cid] = (customerCounts[cid] || 0) + 1;
    }
    let newCust = 0;
    let retCust = 0;
    const custVals = Object.values(customerCounts);
    if (custVals.length > 0) {
      for (const cnt of custVals) {
        if (cnt > 1) retCust++;
        else newCust++;
      }
    } else {
      newCust = salesAnalytics.kpi.orders;
      retCust = 0;
    }

    // Catalog quick stats
    const outOfStockCount = catalog.filter((p) => (p.totalInventory ?? 0) <= 0).length;
    const lowStockCount = catalog.filter((p) => {
      const inv = p.totalInventory ?? 0;
      return inv > 0 && inv <= 5;
    }).length;

    return {
      shop,
      since,
      kpi: salesAnalytics.kpi,
      trendRows: salesAnalytics.trendRows,
      summary: salesAnalytics.summary,
      salesAnomalies: salesAnalytics.anomalies || [],
      health: {
        score: healthScore,
        ...scanStats,
        categories: categoryCounts,
      },
      topProblems: dbProblems.slice(0, 6),
      catalogStats: {
        total: catalog.length,
        outOfStock: outOfStockCount,
        lowStock: lowStockCount,
      },
      customers: {
        new: newCust,
        returning: retCust,
        total: newCust + retCust,
      },
    };
  } catch (fatalErr) {
    console.error("Dashboard loader caught fatal exception gracefully:", fatalErr);
    return {
      shop: "",
      since: "-30d",
      kpi: { grossSales: 0, netSales: 0, orders: 0, unitsSold: 0, aov: 0 },
      trendRows: [],
      summary: { avgDailySales: 0, peakDay: null, lowestDay: null },
      salesAnomalies: [],
      health: {
        score: 100,
        critical: 0,
        warning: 0,
        notice: 0,
        total: 0,
        resolved: 0,
        categories: { inventory: 0, product: 0, seo: 0, performance: 0 },
      },
      topProblems: [],
      catalogStats: { total: 0, outOfStock: 0, lowStock: 0 },
      customers: { new: 0, returning: 0, total: 0 },
    };
  }
};

// ─── ACTION ───────────────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    if (intent === "sync_store") {
      try {
        const scanData = await runStoreScan(admin, session.shop);
        return {
          success: true,
          message: `Store synced! Scanned ${scanData.totalProductsScanned} catalog products. Health Score: ${scanData.healthScore}/100.`,
          actionType: "sync",
        };
      } catch (err) {
        return { success: false, error: err.message || "Sync encountered an error." };
      }
    }

    if (intent === "run_scan" || intent === "rescan") {
      try {
        const scanData = await runStoreScan(admin, session.shop);
        return {
          success: true,
          message: `Full diagnostic scan complete! Analyzed ${scanData.totalProductsScanned} products. Health Score: ${scanData.healthScore}/100.`,
          actionType: "scan",
        };
      } catch (err) {
        return { success: false, error: err.message || "Diagnostic scan failed." };
      }
    }

    if (intent === "quick_fix") {
      const problemId = formData.get("problemId");
      const actionKey = formData.get("actionKey");
      const resourceId = formData.get("resourceId");
      const resourceTitle = formData.get("resourceTitle");

      try {
        const result = await executeAppFix(admin, session.shop, {
          problemId,
          actionKey,
          resourceId,
          resourceTitle,
        });
        return {
          success: true,
          message: result?.message || "Remediation applied successfully!",
          fixedId: problemId,
          actionType: "fix",
        };
      } catch (err) {
        return { success: false, error: err.message || "Failed to execute fix." };
      }
    }

    return { success: false, error: "Invalid action intent" };
  } catch (err) {
    console.error("Action error caught safely:", err);
    return { success: false, error: err.message || "Failed to process request." };
  }
};

// ─── HEALTH RING SVG ──────────────────────────────────────────────────────────
function HealthRing({ score }) {
  const r = 50;
  const circ = 2 * Math.PI * r;
  const progress = ((100 - score) / 100) * circ;
  const color =
    score >= 80 ? "var(--sa-emerald)" : score >= 50 ? "var(--sa-amber)" : "var(--sa-rose)";

  return (
    <div className="sa-health-ring">
      <svg width="130" height="130" viewBox="0 0 130 130">
        <circle cx="65" cy="65" r={r} fill="none" stroke="var(--sa-surface-3)" strokeWidth="10" />
        <circle
          cx="65"
          cy="65"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeDasharray={circ}
          strokeDashoffset={progress}
          strokeLinecap="round"
          transform="rotate(-90 65 65)"
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
        <text
          x="65"
          y="62"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize="28"
          fontWeight="700"
          fontFamily="Inter, sans-serif"
        >
          {score}
        </text>
        <text
          x="65"
          y="82"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--sa-text-muted)"
          fontSize="11"
          fontWeight="500"
          fontFamily="Inter, sans-serif"
        >
          /100
        </text>
      </svg>
      <div className="sa-health-score-sub" style={{ fontWeight: 600 }}>
        Store Diagnostic Health
      </div>
    </div>
  );
}

// ─── SPARKLINE SVG ────────────────────────────────────────────────────────────
function Sparkline({ data = [], color = "var(--sa-emerald)" }) {
  if (!data.length) return null;
  const vals = data.map(Number).filter(isFinite);
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 180;
  const h = 36;
  const pts = vals
    .map((v, i) => {
      const x = (i / Math.max(vals.length - 1, 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="sa-sparkline">
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── METRIC CARD ─────────────────────────────────────────────────────────────
function MetricCard({ label, value, delta, accent = "var(--sa-emerald)", sparkData, subtitle }) {
  const isPositive = delta > 0;
  const isNeutral = delta === 0 || delta == null;

  return (
    <div className="sa-metric-card" style={{ "--sa-accent": accent }}>
      <div className="sa-metric-label">{label}</div>
      <div className="sa-metric-value">{value}</div>
      {!isNeutral ? (
        <span className={`sa-metric-delta ${isPositive ? "up" : "down"}`}>
          {isPositive ? "↑" : "↓"} {Math.abs(delta)}% vs prev
        </span>
      ) : subtitle ? (
        <div className="sa-text-muted sa-text-small">{subtitle}</div>
      ) : (
        <span className="sa-metric-delta neutral">Period baseline</span>
      )}
      {sparkData && sparkData.length > 1 && <Sparkline data={sparkData} color={accent} />}
    </div>
  );
}

// ─── DASHBOARD PAGE COMPONENT ─────────────────────────────────────────────────
export default function OverviewPage() {
  const {
    shop,
    since,
    kpi,
    trendRows,
    summary,
    salesAnomalies,
    health,
    topProblems,
    catalogStats,
    customers,
  } = useLoaderData();

  const [searchParams, setSearchParams] = useSearchParams();
  const actionFetcher = useFetcher();

  const activeSince = searchParams.get("since") || since || "-30d";
  const activePeriodIdx = useMemo(() => {
    const idx = DATE_RANGES.findIndex((r) => r.sinceExpr === activeSince);
    return idx !== -1 ? idx : 1;
  }, [activeSince]);

  const [chartView, setChartView] = useState("revenue"); // 'revenue' | 'orders'
  const [toastMessage, setToastMessage] = useState(null);

  // Monitor action response cleanly without state mutation
  useEffect(() => {
    if (actionFetcher.data) {
      setToastMessage({
        success: actionFetcher.data.success,
        text: actionFetcher.data.message || actionFetcher.data.error,
      });
    }
  }, [actionFetcher.data]);

  const revenueSparkData = trendRows.map((r) => r.gross_sales ?? 0);
  const ordersSparkData = trendRows.map((r) => r.orders ?? 0);

  const totalCustomers = customers.new + customers.returning;
  const returningRate =
    totalCustomers > 0 ? `${((customers.returning / totalCustomers) * 100).toFixed(0)}%` : "0%";

  // Declarative period change using React Router search params
  const handlePeriodChange = (sinceExpr) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("since", sinceExpr);
      return next;
    });
  };

  const handleSyncStore = () => {
    actionFetcher.submit({ intent: "sync_store" }, { method: "POST" });
  };

  const handleRunScan = () => {
    actionFetcher.submit({ intent: "run_scan" }, { method: "POST" });
  };

  const handleQuickFix = (problem) => {
    actionFetcher.submit(
      {
        intent: "quick_fix",
        problemId: problem.id,
        actionKey: problem.actionKey || "",
        resourceId: problem.resourceId || "",
        resourceTitle: problem.resourceTitle || problem.title,
      },
      { method: "POST" }
    );
  };

  const isSyncing = actionFetcher.state === "submitting" && actionFetcher.formData?.get("intent") === "sync_store";
  const isScanning = actionFetcher.state === "submitting" && actionFetcher.formData?.get("intent") === "run_scan";

  return (
    <div className="sa-page sa-fade-in">
      {/* Header exactly matching requirement & screenshot */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Store Diagnostics & Performance Radar</div>
          <div className="sa-page-subtitle">
            Automated defect detection, Core Web Vitals benchmarking, and 1-click remediation
          </div>
        </div>
        <div className="sa-inline">
          {/* Date interval pills */}
          <div className="sa-date-pills">
            {DATE_RANGES.map((r, i) => (
              <button
                key={r.label}
                className={`sa-date-pill${activePeriodIdx === i ? " active" : ""}`}
                onClick={() => handlePeriodChange(r.sinceExpr)}
              >
                {r.label}
              </button>
            ))}
          </div>

          {/* Sync Store Button */}
          <button
            onClick={handleSyncStore}
            disabled={isSyncing || isScanning}
            className="sa-btn"
            style={{
              background: "var(--sa-surface)",
              border: "1px solid var(--sa-border)",
              color: "var(--sa-text)",
              fontSize: 13,
              fontWeight: 500,
              padding: "6px 14px",
              cursor: isSyncing ? "wait" : "pointer",
            }}
          >
            {isSyncing ? "⚡ Syncing..." : "⚡ Sync Store"}
          </button>

          {/* Run Scan Button in vibrant orange */}
          <button
            onClick={handleRunScan}
            disabled={isScanning || isSyncing}
            className="sa-btn"
            style={{
              background: "linear-gradient(180deg, #d97706 0%, #b45309 100%)",
              border: "1px solid #b45309",
              color: "#ffffff",
              fontSize: 13,
              fontWeight: 600,
              padding: "6px 14px",
              cursor: isScanning ? "wait" : "pointer",
              boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
            }}
          >
            {isScanning ? "🔄 Scanning..." : "🔄 Run Scan"}
          </button>
        </div>
      </div>

      {/* Action Notification Toast */}
      {toastMessage && (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-5)",
            padding: "12px 16px",
            borderColor: toastMessage.success ? "var(--sa-emerald)" : "var(--sa-rose)",
            background: toastMessage.success ? "rgba(16,185,129,0.08)" : "rgba(244,63,94,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{toastMessage.success ? "✅" : "⚠️"}</span>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{toastMessage.text}</div>
          </div>
          <button
            onClick={() => setToastMessage(null)}
            className="sa-btn sa-btn-ghost"
            style={{ padding: "2px 8px", fontSize: 11 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* NOTE: The '6 Critical Store Issues Require Immediate Attention' banner has been completely removed as requested */}

      {/* Metrics Row with Comparative Growth */}
      <div className="sa-metrics-grid">
        <MetricCard
          label="Gross Revenue"
          value={fmtMoney(kpi.grossSales)}
          delta={kpi.revenueGrowth}
          accent="var(--sa-emerald)"
          sparkData={revenueSparkData}
        />
        <MetricCard
          label="Net Sales"
          value={fmtMoney(kpi.netSales)}
          accent="var(--sa-cyan)"
          subtitle={
            kpi.grossSales > 0
              ? `${Math.round((kpi.netSales / kpi.grossSales) * 100)}% of gross`
              : "Post discounts"
          }
        />
        <MetricCard
          label="Orders"
          value={fmtNum(kpi.orders)}
          delta={kpi.orderGrowth}
          accent="var(--sa-indigo)"
          sparkData={ordersSparkData}
        />
        <MetricCard
          label="Avg. Order Value"
          value={fmtMoney(kpi.aov)}
          delta={kpi.aovGrowth}
          accent="var(--sa-amber)"
        />
        <MetricCard
          label="Units Sold"
          value={fmtNum(kpi.unitsSold)}
          delta={kpi.unitsGrowth}
          accent="var(--sa-violet)"
        />
        <MetricCard
          label="Active SKUs"
          value={fmtNum(catalogStats.total)}
          accent="var(--sa-orange)"
          subtitle={
            catalogStats.outOfStock > 0
              ? `⚠️ ${catalogStats.outOfStock} out of stock`
              : "All stock healthy"
          }
        />
      </div>

      {/* Content Grid: Left (Analytics & Insights), Right (Health & Remediation) */}
      <div className="sa-content-grid">
        {/* Left Stack */}
        <div className="sa-stack" style={{ gap: "var(--sa-space-5)" }}>
          {/* Revenue & Order Velocity Chart */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                <div className="sa-card-title">
                  {chartView === "revenue" ? "Revenue Velocity" : "Order Volume Trend"}
                </div>
                {summary?.peakDay && (
                  <span className="sa-badge success" style={{ textTransform: "none" }}>
                    🏆 Peak: {fmtMoney(summary.peakDay.gross_sales)} ({summary.peakDay.day})
                  </span>
                )}
                {summary?.avgDailySales > 0 && (
                  <span className="sa-badge neutral" style={{ textTransform: "none" }}>
                    Avg: {fmtMoney(summary.avgDailySales)}/day
                  </span>
                )}
              </div>
              <div className="sa-date-pills">
                <button
                  className={`sa-date-pill${chartView === "revenue" ? " active" : ""}`}
                  onClick={() => setChartView("revenue")}
                >
                  Revenue
                </button>
                <button
                  className={`sa-date-pill${chartView === "orders" ? " active" : ""}`}
                  onClick={() => setChartView("orders")}
                >
                  Orders
                </button>
              </div>
            </div>

            <div className="sa-card-body">
              {trendRows.length > 0 ? (
                <div>
                  <div style={{ width: "100%", height: 220, position: "relative" }}>
                    <svg
                      viewBox="0 0 800 200"
                      preserveAspectRatio="none"
                      style={{ width: "100%", height: "100%" }}
                    >
                      <defs>
                        <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                          <stop
                            offset="0%"
                            stopColor={chartView === "revenue" ? "#10b981" : "#6366f1"}
                            stopOpacity="0.3"
                          />
                          <stop
                            offset="100%"
                            stopColor={chartView === "revenue" ? "#10b981" : "#6366f1"}
                            stopOpacity="0"
                          />
                        </linearGradient>
                      </defs>

                      {(() => {
                        const vals = trendRows.map((r) =>
                          chartView === "revenue" ? r.gross_sales || 0 : r.orders || 0
                        );
                        const maxV = Math.max(...vals, 1);
                        const pts = vals
                          .map((v, i) => {
                            const x = (i / Math.max(vals.length - 1, 1)) * 780 + 10;
                            const y = 190 - (v / maxV) * 170;
                            return `${x},${y}`;
                          })
                          .join(" ");

                        const areaBase = `10,190 ${pts} ${
                          ((vals.length - 1) / Math.max(vals.length - 1, 1)) * 780 + 10
                        },190`;

                        const strokeColor = chartView === "revenue" ? "#10b981" : "#6366f1";

                        return (
                          <>
                            <polygon points={areaBase} fill="url(#dashGrad)" />
                            <polyline
                              points={pts}
                              fill="none"
                              stroke={strokeColor}
                              strokeWidth="2.5"
                              strokeLinejoin="round"
                              strokeLinecap="round"
                            />
                            {trendRows.map((r, i) => {
                              const val = chartView === "revenue" ? r.gross_sales || 0 : r.orders || 0;
                              const cx = (i / Math.max(vals.length - 1, 1)) * 780 + 10;
                              const cy = 190 - (val / maxV) * 170;
                              return (
                                <circle
                                  key={r.day}
                                  cx={cx}
                                  cy={cy}
                                  r={trendRows.length > 25 ? 2 : 4}
                                  fill={strokeColor}
                                  stroke="var(--sa-surface)"
                                  strokeWidth="1.5"
                                />
                              );
                            })}
                          </>
                        );
                      })()}
                    </svg>
                  </div>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11,
                      color: "var(--sa-text-dimmed)",
                      marginTop: 6,
                    }}
                  >
                    <span>{trendRows[0]?.day}</span>
                    <span>{trendRows[trendRows.length - 1]?.day}</span>
                  </div>
                </div>
              ) : (
                <div className="sa-empty">
                  <div className="sa-empty-icon">📊</div>
                  <div className="sa-empty-title">No transactions recorded</div>
                  <div className="sa-empty-body">
                    When sales activity takes place, your revenue curve and velocity trends will appear here.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Catalog & Customer Health Summary */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-4)" }}>
            <div className="sa-card">
              <div className="sa-card-header">
                <div className="sa-card-title">Inventory Health</div>
                <a href="/app/inventory" className="sa-btn sa-btn-ghost" style={{ padding: "2px 8px", fontSize: 11 }}>
                  Manage →
                </a>
              </div>
              <div className="sa-card-body">
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>In-Stock Active:</span>
                  <strong style={{ color: "var(--sa-emerald)" }}>
                    {fmtNum(catalogStats.total - catalogStats.outOfStock)}
                  </strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>Low Stock Alert:</span>
                  <strong style={{ color: "var(--sa-amber)" }}>{fmtNum(catalogStats.lowStock)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>Out of Stock:</span>
                  <strong style={{ color: catalogStats.outOfStock > 0 ? "var(--sa-rose)" : "inherit" }}>
                    {fmtNum(catalogStats.outOfStock)}
                  </strong>
                </div>
              </div>
            </div>

            <div className="sa-card">
              <div className="sa-card-header">
                <div className="sa-card-title">Customer Retention</div>
                <span className="sa-badge neutral">{returningRate} Returning</span>
              </div>
              <div className="sa-card-body">
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>Total Buyers:</span>
                  <strong>{fmtNum(customers.total)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>New Customers:</span>
                  <strong style={{ color: "var(--sa-cyan)" }}>{fmtNum(customers.new)}</strong>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="sa-text-muted" style={{ fontSize: 13 }}>Repeat Buyers:</span>
                  <strong style={{ color: "var(--sa-violet)" }}>{fmtNum(customers.returning)}</strong>
                </div>
              </div>
            </div>
          </div>

          {/* Problem Categories Breakdown */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Diagnostic Categories</div>
              <span className="sa-badge neutral">{health.total} Total Issues</span>
            </div>
            <div className="sa-card-body">
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, textAlign: "center" }}>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: "var(--sa-radius-sm)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-emerald)" }}>
                    {health.categories.inventory}
                  </div>
                  <div className="sa-text-muted sa-text-small" style={{ marginTop: 2 }}>Inventory</div>
                </div>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: "var(--sa-radius-sm)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-indigo)" }}>
                    {health.categories.product}
                  </div>
                  <div className="sa-text-muted sa-text-small" style={{ marginTop: 2 }}>Product</div>
                </div>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: "var(--sa-radius-sm)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-amber)" }}>
                    {health.categories.seo}
                  </div>
                  <div className="sa-text-muted sa-text-small" style={{ marginTop: 2 }}>SEO</div>
                </div>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: "var(--sa-radius-sm)" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-violet)" }}>
                    {health.categories.performance}
                  </div>
                  <div className="sa-text-muted sa-text-small" style={{ marginTop: 2 }}>Speed</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Stack: Health Score & Actionable Problems */}
        <div className="sa-stack" style={{ gap: "var(--sa-space-5)" }}>
          {/* Store Health Score Ring */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Store Diagnostic Health</div>
              <span
                className={`sa-badge ${
                  health.score >= 80 ? "success" : health.score >= 50 ? "warning" : "critical"
                }`}
              >
                {health.score >= 80 ? "Good" : health.score >= 50 ? "Needs Attention" : "Critical"}
              </span>
            </div>
            <HealthRing score={health.score} />
            <div className="sa-divider" style={{ margin: "0 var(--sa-space-4)" }} />
            <div className="sa-card-body" style={{ paddingTop: "var(--sa-space-3)" }}>
              <div style={{ display: "flex", gap: "var(--sa-space-4)", justifyContent: "center" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-rose)" }}>
                    {health.critical}
                  </div>
                  <div className="sa-text-muted sa-text-small">Critical</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-amber)" }}>
                    {health.warning}
                  </div>
                  <div className="sa-text-muted sa-text-small">Warnings</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-violet)" }}>
                    {health.notice}
                  </div>
                  <div className="sa-text-muted sa-text-small">Notices</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-emerald)" }}>
                    {health.resolved}
                  </div>
                  <div className="sa-text-muted sa-text-small">Resolved</div>
                </div>
              </div>
            </div>
          </div>

          {/* Top Actionable Problems */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Top Priority Issues</div>
              <a href="/app/problems" className="sa-btn sa-btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
                View all ({health.total}) →
              </a>
            </div>
            <div className="sa-card-body no-pad">
              {topProblems.length > 0 ? (
                topProblems.map((prob) => {
                  const severityClass =
                    prob.severity === "CRITICAL"
                      ? "critical"
                      : prob.severity === "WARNING"
                      ? "warning"
                      : "notice";
                  const fixClass = prob.fixType === "APP_FIX" ? "app-fix" : "dev-fix";
                  const isAppFix = prob.fixType === "APP_FIX";

                  return (
                    <div key={prob.id} className="sa-problem-card">
                      <div className="sa-problem-card-header">
                        <div className="sa-problem-title">{prob.title}</div>
                        <div className="sa-problem-badges">
                          <span className={`sa-badge ${severityClass}`}>{prob.severity}</span>
                          <span className={`sa-badge ${fixClass}`}>
                            {isAppFix ? "1-Click Fix" : "Dev Fix"}
                          </span>
                        </div>
                      </div>
                      <div className="sa-problem-desc">{prob.description}</div>
                      <div
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          marginTop: 6,
                        }}
                      >
                        <div style={{ fontSize: 11, color: "var(--sa-text-dimmed)" }}>
                          {prob.resourceType || "Product"} · {prob.category}
                        </div>
                        <div style={{ display: "flex", gap: 6 }}>
                          {isAppFix && (
                            <button
                              onClick={() => handleQuickFix(prob)}
                              disabled={actionFetcher.state === "submitting"}
                              className="sa-btn sa-btn-primary"
                              style={{ padding: "3px 9px", fontSize: 11 }}
                            >
                              ⚡ Quick Fix
                            </button>
                          )}
                          {prob.resourceUrl && (
                            <a
                              href={prob.resourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="sa-btn sa-btn-ghost"
                              style={{ padding: "3px 9px", fontSize: 11 }}
                            >
                              Shopify ↗
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                  <div className="sa-empty-icon">✅</div>
                  <div className="sa-empty-title">All systems healthy</div>
                  <div className="sa-empty-body">
                    No open problems detected. Run diagnostics anytime to verify catalog and storefront health.
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="sa-page sa-fade-in">
      <div
        className="sa-card"
        style={{
          padding: "var(--sa-space-6)",
          maxWidth: 640,
          margin: "40px auto",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>
          Dashboard Diagnostics Notice
        </div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "Unexpected Server Error"}
        </div>
        <div style={{ display: "flex", justifyContent: "center", gap: 12 }}>
          <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
            🔄 Reload Dashboard
          </button>
          <a href="/app" className="sa-btn sa-btn-secondary">
            Return to Overview
          </a>
        </div>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
