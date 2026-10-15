import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActionAdmin } from "../services/auth.server.js";
import { getShopifyAdminUrl } from "../utils/navigation.js";
import {
  getPeriodDates,
  fetchStoreOrders,
  fetchStoreCatalog,
  computeSalesAnalytics,
} from "../services/analytics.server";
import { runStoreScan } from "../services/scanner.server";
import { executeAppFix, bulkFixAllCritical } from "../services/fixes.server";
import {
  syncStoreSalesHistory,
  syncStoreCatalogSnapshots,
  getStoreSyncStatus,
} from "../services/sync.server";
import { getStoreThemes } from "../services/theme.server";
import { getThemeSpeedAudit } from "../services/performance.server";
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
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const since = url.searchParams.get("since") || "-30d";
  const periodDates = getPeriodDates(since);

  // 1. Fetch Orders & Calculate Sales Analytics with Period-Over-Period Growth
  let orders = [];
  try {
    orders = await fetchStoreOrders(admin, periodDates.previousStartDate);
  } catch (err) {
    console.warn("Failed to fetch orders for dashboard:", err.message);
  }
  const salesAnalytics = computeSalesAnalytics(orders, periodDates);

  // 2. Fetch Catalog Snapshot
  let catalog = [];
  try {
    catalog = await fetchStoreCatalog(admin);
  } catch (err) {
    console.warn("Failed to fetch catalog for dashboard:", err.message);
  }

  // 3. Retrieve or Execute Problem Diagnostic Scan
  let dbProblems = [];
  let resolvedCount = 0;
  try {
    dbProblems = await prisma.problem.findMany({
      where: { shop, resolvedAt: null, ignoredAt: null },
      orderBy: { createdAt: "desc" },
    });
    resolvedCount = await prisma.problem.count({
      where: { shop, resolvedAt: { not: null } },
    });
  } catch (err) {
    console.warn("Database lookup caught in dashboard loader:", err.message);
  }

  // If no diagnostic problems in DB, run a full store scan automatically
  let scanStats = null;
  let healthScore = 100;
  if (dbProblems.length === 0) {
    try {
      const scanResult = await runStoreScan(admin, shop);
      dbProblems = scanResult.problems || [];
      healthScore = scanResult.healthScore || 100;
      scanStats = scanResult.stats;
    } catch (scanErr) {
      console.warn("Auto-scan failed in dashboard loader:", scanErr.message);
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

  // 4. Retrieve Themes and Theme-wise Site Speed Analysis
  let themes = [];
  try {
    themes = await getStoreThemes(admin, shop);
  } catch (err) {
    console.warn("Theme lookup caught in dashboard loader:", err.message);
  }

  const requestedThemeId = url.searchParams.get("themeId");
  const liveTheme = themes.find((t) => t.isLive) || themes[0];
  const activeThemeId = requestedThemeId || liveTheme?.shopifyId || liveTheme?.id || "default";

  let themeSpeedAudit = null;
  try {
    themeSpeedAudit = await getThemeSpeedAudit(admin, shop, activeThemeId);
  } catch (err) {
    console.warn("Theme speed audit caught in dashboard loader:", err.message);
  }

  // Background sync metadata
  const syncStatus = await getStoreSyncStatus(shop);

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
    topProblems: dbProblems.slice(0, 8),
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
    syncStatus,
    themes,
    activeThemeId,
    themeSpeedAudit,
  };
};

// ─── ACTION ───────────────────────────────────────────────────────────────────
export const action = async ({ request }) => {
  const formData = await request.formData();
  const { admin, session, shop } = await getActionAdmin(request, formData);
  const intent = formData.get("intent");

  if (intent === "quick_fix") {
    const problemId = formData.get("problemId");
    const actionKey = formData.get("actionKey");
    const resourceId = formData.get("resourceId");
    const resourceTitle = formData.get("resourceTitle");

    try {
      const result = await executeAppFix(admin, shop, {
        problemId,
        actionKey,
        resourceId,
        resourceTitle,
      });
      return {
        success: true,
        message: result?.message || "Remediation applied successfully!",
        fixedId: problemId,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to execute fix." };
    }
  }

  if (intent === "ignore_problem") {
    const problemId = formData.get("problemId");
    try {
      await executeAppFix(admin, shop, {
        problemId,
        actionKey: "IGNORE_PROBLEM",
      });
      return {
        success: true,
        message: "Problem dismissed from active queue.",
        ignoredId: problemId,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to dismiss problem." };
    }
  }

  if (intent === "bulk_fix_critical") {
    try {
      const result = await bulkFixAllCritical(admin, shop);
      return {
        success: true,
        message: result.message,
      };
    } catch (err) {
      return { success: false, error: err.message || "Bulk fix failed." };
    }
  }

  if (intent === "test_theme_speed") {
    const themeId = formData.get("themeId");
    try {
      const audit = await getThemeSpeedAudit(admin, shop, themeId);
      return {
        success: true,
        message: `Speed audit complete for "${audit.themeName}"! Mobile: ${audit.mobile.score}/100 · Desktop: ${audit.desktop.score}/100`,
        speedAudit: audit,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to analyze theme speed." };
    }
  }

  if (intent === "rescan") {
    try {
      const scanData = await runStoreScan(admin, shop);
      return {
        success: true,
        message: `Diagnostic scan complete! Analyzed ${scanData.totalProductsScanned} products. Health score: ${scanData.healthScore}/100.`,
      };
    } catch (err) {
      return { success: false, error: err.message || "Scan failed." };
    }
  }

  if (intent === "sync_all") {
    try {
      const salesResult = await syncStoreSalesHistory(admin, shop, 30);
      const catalogResult = await syncStoreCatalogSnapshots(admin, shop);
      const scanResult = await runStoreScan(admin, shop);

      return {
        success: true,
        message: `Store synchronized! Synced ${salesResult.ordersSynced} orders, ${catalogResult.productsSynced} products. Health score: ${scanResult.healthScore}/100.`,
      };
    } catch (err) {
      return { success: false, error: err.message || "Full sync failed." };
    }
  }

  return { success: false, error: "Invalid action intent" };
};

// ─── SPEED GAUGE SVG ──────────────────────────────────────────────────────────
function SpeedGauge({ score = 0, label = "Speed Score", sublabel = "", size = 110 }) {
  const r = size / 2 - 12;
  const circ = 2 * Math.PI * r;
  const progress = Math.max(0, Math.min(circ, ((100 - score) / 100) * circ));
  const color =
    score >= 80 ? "var(--sa-emerald)" : score >= 50 ? "var(--sa-amber)" : "var(--sa-rose)";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--sa-surface-3)"
          strokeWidth="8"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="8"
          strokeDasharray={circ}
          strokeDashoffset={progress}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
        <text
          x={size / 2}
          y={size / 2 - 4}
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize="24"
          fontWeight="700"
          fontFamily="Inter, sans-serif"
        >
          {score}
        </text>
        <text
          x={size / 2}
          y={size / 2 + 15}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--sa-text-muted)"
          fontSize="10"
          fontWeight="600"
          fontFamily="Inter, sans-serif"
        >
          /100
        </text>
      </svg>
      <div style={{ fontSize: 12, fontWeight: 600, color: "var(--sa-text)" }}>{label}</div>
      {sublabel && (
        <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>{sublabel}</div>
      )}
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

// ─── DASHBOARD PAGE ───────────────────────────────────────────────────────────
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
    syncStatus,
    themes = [],
    activeThemeId,
    themeSpeedAudit,
  } = useLoaderData();

  const [searchParams, setSearchParams] = useSearchParams();
  const actionFetcher = useFetcher();

  const [selectedThemeId, setSelectedThemeId] = useState(activeThemeId);
  const [deviceMode, setDeviceMode] = useState("mobile"); // 'mobile' | 'desktop'
  const [toastDismissed, setToastDismissed] = useState(false);
  const [dismissedProblems, setDismissedProblems] = useState(new Set());
  const [chartView, setChartView] = useState("revenue"); // 'revenue' | 'orders'

  const activePeriod = DATE_RANGES.findIndex((r) => r.sinceExpr === since) !== -1
    ? DATE_RANGES.findIndex((r) => r.sinceExpr === since)
    : 1;

  // React to fetcher completion
  useEffect(() => {
    if (actionFetcher.data) {
      setToastDismissed(false);
      if (actionFetcher.data.fixedId) {
        setDismissedProblems((prev) => new Set([...prev, actionFetcher.data.fixedId]));
      }
      if (actionFetcher.data.ignoredId) {
        setDismissedProblems((prev) => new Set([...prev, actionFetcher.data.ignoredId]));
      }
      if (actionFetcher.data.speedAudit?.themeId) {
        setSelectedThemeId(actionFetcher.data.speedAudit.themeId);
      }
    }
  }, [actionFetcher.data]);

  const activeSpeedAudit = actionFetcher.data?.speedAudit || themeSpeedAudit;

  // Fallback themes list if empty
  const availableThemes =
    themes.length > 0
      ? themes
      : [
          {
            id: "default-dawn",
            shopifyId: activeThemeId || "default",
            name: "Dawn (Live Theme)",
            isLive: true,
            role: "MAIN",
          },
        ];

  const currentVitals = activeSpeedAudit?.[deviceMode] || activeSpeedAudit?.mobile || {
    score: 72,
    lcp: "2.4",
    inp: 105,
    cls: "0.05",
    loadTime: "2.8",
    pageSize: 1850,
    jsSize: 520,
    cssSize: 160,
    imageSize: 980,
    thirdPartyCount: 8,
  };

  const revenueSparkData = trendRows.map((r) => r.gross_sales ?? 0);
  const ordersSparkData = trendRows.map((r) => r.orders ?? 0);

  const totalCustomers = customers.new + customers.returning;
  const returningRate =
    totalCustomers > 0 ? `${((customers.returning / totalCustomers) * 100).toFixed(0)}%` : "0%";

  const handlePeriodChange = (idx) => {
    const { sinceExpr } = DATE_RANGES[idx];
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("since", sinceExpr);
      return next;
    });
  };

  const submitAction = (payload) => {
    actionFetcher.submit(
      { shop: shop || "", ...payload },
      {
        method: "POST",
        action: typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined,
      }
    );
  };

  const handleThemeChange = (newThemeId) => {
    setSelectedThemeId(newThemeId);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("themeId", newThemeId);
      return next;
    });
    // Trigger on-demand speed audit for selected theme
    submitAction({ intent: "test_theme_speed", themeId: newThemeId });
  };

  const handleRunSpeedTest = () => {
    submitAction({ intent: "test_theme_speed", themeId: selectedThemeId });
  };

  const handleRunScan = () => {
    submitAction({ intent: "rescan" });
  };

  const handleSyncAll = () => {
    submitAction({ intent: "sync_all" });
  };

  const handleBulkFixCritical = () => {
    submitAction({ intent: "bulk_fix_critical" });
  };

  const handleQuickFix = (problem) => {
    submitAction({
      intent: "quick_fix",
      problemId: problem.id,
      actionKey: problem.actionKey || "",
      resourceId: problem.resourceId || "",
      resourceTitle: problem.resourceTitle || problem.title,
    });
  };

  const handleIgnoreProblem = (problemId) => {
    submitAction({
      intent: "ignore_problem",
      problemId,
    });
  };

  const isScanning =
    actionFetcher.state === "submitting" &&
    actionFetcher.formData?.get("intent") === "rescan";
  const isSyncing =
    actionFetcher.state === "submitting" &&
    actionFetcher.formData?.get("intent") === "sync_all";
  const isBulkFixing =
    actionFetcher.state === "submitting" &&
    actionFetcher.formData?.get("intent") === "bulk_fix_critical";
  const isTestingSpeed =
    actionFetcher.state === "submitting" &&
    actionFetcher.formData?.get("intent") === "test_theme_speed";

  const visibleProblems = topProblems.filter((p) => !dismissedProblems.has(p.id));

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Store Diagnostics & Analytics Dashboard</div>
          <div className="sa-page-subtitle">
            Real-time theme speed benchmarking, catalog health, problem detection, and 1-click remediation
          </div>
        </div>
        <div className="sa-inline">
          <div className="sa-date-pills">
            {DATE_RANGES.map((r, i) => (
              <button
                key={r.label}
                className={`sa-date-pill${activePeriod === i ? " active" : ""}`}
                onClick={() => handlePeriodChange(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button
            onClick={handleSyncAll}
            disabled={isSyncing}
            className="sa-btn sa-btn-secondary"
            style={{ fontSize: 12, padding: "5px 12px" }}
            title="Synchronize historical sales snapshots, catalog cache, and diagnostics"
          >
            {isSyncing ? "⚡ Syncing..." : "⚡ Sync Store"}
          </button>
          <button
            onClick={handleRunScan}
            disabled={isScanning}
            className="sa-btn sa-btn-primary"
            style={{ fontSize: 12, padding: "5px 14px" }}
          >
            {isScanning ? "Scanning Catalog..." : "🔄 Run Diagnostics"}
          </button>
        </div>
      </div>

      {/* Action Notification Toast */}
      {actionFetcher.data && !toastDismissed && (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-5)",
            padding: "12px 16px",
            borderColor: actionFetcher.data.success ? "var(--sa-emerald)" : "var(--sa-rose)",
            background: actionFetcher.data.success ? "rgba(16,185,129,0.08)" : "rgba(244,63,94,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{actionFetcher.data.success ? "✅" : "⚠️"}</span>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {actionFetcher.data.message || actionFetcher.data.error}
            </div>
          </div>
          <button
            onClick={() => setToastDismissed(true)}
            className="sa-btn sa-btn-ghost"
            style={{ padding: "2px 8px", fontSize: 11 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* High-Priority Diagnostic Banner if Critical Problems Exist */}
      {health.critical > 0 && (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-6)",
            borderColor: "rgba(244, 63, 94, 0.4)",
            background: "linear-gradient(180deg, rgba(244, 63, 94, 0.08) 0%, var(--sa-surface) 100%)",
            padding: "14px 18px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              flexWrap: "wrap",
              gap: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 22 }}>🚨</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: "var(--sa-rose)" }}>
                  {health.critical} Critical Store {health.critical === 1 ? "Problem" : "Problems"} Requiring Attention
                </div>
                <div className="sa-text-muted" style={{ fontSize: 12 }}>
                  Critical issues directly impact customer checkout or conversion (e.g. out-of-stock active products or pricing errors).
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                disabled={isBulkFixing}
                onClick={handleBulkFixCritical}
                className="sa-btn sa-btn-danger"
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                {isBulkFixing ? "Fixing..." : "⚡ 1-Click Fix All Critical"}
              </button>
              <Link
                to="/app/problems"
                className="sa-btn sa-btn-secondary"
                style={{ fontSize: 12, padding: "5px 12px" }}
              >
                Review All →
              </Link>
            </div>
          </div>
        </div>
      )}

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
          accent="var(--sa-teal)"
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
          accent="var(--sa-purple)"
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

      {/* Content Grid: Left (Analytics & Insights), Right (Theme Speed & Health Engine) */}
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
              <div className="sa-tabs" style={{ marginBottom: 0 }}>
                <button
                  className={`sa-tab${chartView === "revenue" ? " active" : ""}`}
                  onClick={() => setChartView("revenue")}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  Revenue ($)
                </button>
                <button
                  className={`sa-tab${chartView === "orders" ? " active" : ""}`}
                  onClick={() => setChartView("orders")}
                  style={{ fontSize: 12, padding: "4px 10px" }}
                >
                  Orders (#)
                </button>
              </div>
            </div>

            <div className="sa-card-body">
              {trendRows.length > 1 ? (
                <div style={{ width: "100%", height: 210, position: "relative" }}>
                  <svg width="100%" height="100%" viewBox="0 0 600 200" preserveAspectRatio="none">
                    <defs>
                      <linearGradient id="dashGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--sa-emerald)" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="var(--sa-emerald)" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>

                    {/* Area polygon */}
                    <polygon
                      points={`20,180 ${trendRows
                        .map((r, i) => {
                          const x = 20 + (i / Math.max(trendRows.length - 1, 1)) * 560;
                          const val = chartView === "revenue" ? r.gross_sales : r.orders;
                          const maxVal = Math.max(
                            ...trendRows.map((d) => (chartView === "revenue" ? d.gross_sales : d.orders)),
                            1
                          );
                          const y = 180 - (val / maxVal) * 160;
                          return `${x},${y}`;
                        })
                        .join(" ")} 580,180`}
                      fill="url(#dashGrad)"
                    />

                    {/* Polyline curve */}
                    <polyline
                      points={trendRows
                        .map((r, i) => {
                          const x = 20 + (i / Math.max(trendRows.length - 1, 1)) * 560;
                          const val = chartView === "revenue" ? r.gross_sales : r.orders;
                          const maxVal = Math.max(
                            ...trendRows.map((d) => (chartView === "revenue" ? d.gross_sales : d.orders)),
                            1
                          );
                          const y = 180 - (val / maxVal) * 160;
                          return `${x},${y}`;
                        })
                        .join(" ")}
                      fill="none"
                      stroke={chartView === "revenue" ? "var(--sa-emerald)" : "var(--sa-indigo)"}
                      strokeWidth="2.5"
                      strokeLinecap="round"
                    />

                    {/* Point circles */}
                    {trendRows.map((r, i) => {
                      const x = 20 + (i / Math.max(trendRows.length - 1, 1)) * 560;
                      const val = chartView === "revenue" ? r.gross_sales : r.orders;
                      const maxVal = Math.max(
                        ...trendRows.map((d) => (chartView === "revenue" ? d.gross_sales : d.orders)),
                        1
                      );
                      const y = 180 - (val / maxVal) * 160;
                      return (
                        <circle
                          key={r.day}
                          cx={x}
                          cy={y}
                          r="3.5"
                          fill="var(--sa-surface-1)"
                          stroke={chartView === "revenue" ? "var(--sa-emerald)" : "var(--sa-indigo)"}
                          strokeWidth="2"
                        >
                          <title>{`${r.day}: ${chartView === "revenue" ? fmtMoney(val) : `${val} orders`}`}</title>
                        </circle>
                      );
                    })}
                  </svg>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      padding: "0 20px",
                      fontSize: 10,
                      color: "var(--sa-text-muted)",
                      marginTop: 4,
                    }}
                  >
                    <span>{trendRows[0]?.day}</span>
                    <span>{trendRows[Math.floor(trendRows.length / 2)]?.day}</span>
                    <span>{trendRows[trendRows.length - 1]?.day}</span>
                  </div>
                </div>
              ) : (
                <div className="sa-empty" style={{ padding: "var(--sa-space-6)" }}>
                  <div className="sa-empty-icon">📈</div>
                  <div className="sa-empty-title">Insufficient Sales Points</div>
                  <div className="sa-empty-body">
                    Orders will dynamically populate this chart as they arrive.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Quick Module Navigation & Drilldown Cards */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-4)" }}>
            <Link
              to="/app/sales"
              className="sa-card"
              style={{
                textDecoration: "none",
                color: "inherit",
                padding: "16px",
                borderLeft: "4px solid var(--sa-emerald)",
                transition: "transform 0.15s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>📊 Sales Analytics</div>
                <span style={{ fontSize: 12 }}>↗</span>
              </div>
              <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
                Day-of-week analysis, AOV growth, and order drilldown tables.
              </div>
            </Link>

            <Link
              to="/app/products"
              className="sa-card"
              style={{
                textDecoration: "none",
                color: "inherit",
                padding: "16px",
                borderLeft: "4px solid var(--sa-indigo)",
                transition: "transform 0.15s ease",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>📦 Product Intelligence</div>
                <span style={{ fontSize: 12 }}>↗</span>
              </div>
              <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
                Velocity, days of supply, stockout risk alerts, and dead stock.
              </div>
            </Link>
          </div>

          {/* Customer Retention Snapshot */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Customer Retention Telemetry</div>
              <span className="sa-badge neutral">{returningRate} Returning</span>
            </div>
            <div className="sa-card-body">
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: 6 }}>
                  <div className="sa-text-muted sa-text-small">Total Buyers</div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>
                    {fmtNum(customers.total)}
                  </div>
                </div>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: 6 }}>
                  <div className="sa-text-muted sa-text-small">New Customers</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-cyan)", marginTop: 4 }}>
                    {fmtNum(customers.new)}
                  </div>
                </div>
                <div style={{ background: "var(--sa-surface-2)", padding: 12, borderRadius: 6 }}>
                  <div className="sa-text-muted sa-text-small">Repeat Buyers</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-purple)", marginTop: 4 }}>
                    {fmtNum(customers.returning)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Stack: Theme Speed & Health Engine + Problem Triage */}
        <div className="sa-stack" style={{ gap: "var(--sa-space-5)" }}>
          {/* THEME SPEED & STOREFRONT HEALTH ENGINE */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div>
                <div className="sa-card-title">⚡ Store Health: Theme Speed & Web Vitals</div>
                <div className="sa-text-muted sa-text-small">
                  Benchmarked against real Liquid assets, script weights, and mobile network conditions
                </div>
              </div>
              {activeSpeedAudit?.testedAt && (
                <span className="sa-badge neutral" style={{ fontSize: 11 }}>
                  Tested {new Date(activeSpeedAudit.testedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </div>

            <div className="sa-card-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {/* Theme Dropdown & Test Action */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  flexWrap: "wrap",
                  gap: 10,
                  background: "var(--sa-surface-2)",
                  padding: "10px 14px",
                  borderRadius: "var(--sa-radius)",
                  border: "1px solid var(--sa-border)",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 220 }}>
                  <label htmlFor="themeSelect" style={{ fontSize: 12, fontWeight: 600, color: "var(--sa-text-muted)" }}>
                    Theme:
                  </label>
                  <select
                    id="themeSelect"
                    value={selectedThemeId}
                    onChange={(e) => handleThemeChange(e.target.value)}
                    className="sa-select"
                    style={{ flex: 1 }}
                  >
                    {availableThemes.map((t) => (
                      <option key={t.shopifyId || t.id} value={t.shopifyId || t.id}>
                        {t.name} {t.isLive ? "🌟 [LIVE]" : `[${t.role || "Draft"}]`}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={handleRunSpeedTest}
                  disabled={isTestingSpeed}
                  className="sa-btn sa-btn-primary"
                  style={{ fontSize: 12, padding: "6px 14px" }}
                  title="Run real-time performance and asset weight audit on selected theme"
                >
                  {isTestingSpeed ? "Analyzing Theme..." : "⚡ Run Speed Test"}
                </button>
              </div>

              {/* Dual Device Selector (Mobile 📱 vs Desktop 💻) */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => setDeviceMode("mobile")}
                  style={{
                    background: deviceMode === "mobile" ? "var(--sa-surface-3)" : "var(--sa-surface-2)",
                    border: deviceMode === "mobile" ? "1px solid var(--sa-emerald)" : "1px solid var(--sa-border)",
                    borderRadius: "var(--sa-radius-sm)",
                    padding: "10px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    textAlign: "left",
                    color: "inherit",
                    transition: "all var(--sa-transition)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>📱</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Mobile Speed</div>
                      <div className="sa-text-muted" style={{ fontSize: 11 }}>
                        4G network throttle
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color:
                        (activeSpeedAudit?.mobile?.score ?? 0) >= 80
                          ? "var(--sa-emerald)"
                          : (activeSpeedAudit?.mobile?.score ?? 0) >= 50
                          ? "var(--sa-amber)"
                          : "var(--sa-rose)",
                    }}
                  >
                    {activeSpeedAudit?.mobile?.score ?? "--"}/100
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setDeviceMode("desktop")}
                  style={{
                    background: deviceMode === "desktop" ? "var(--sa-surface-3)" : "var(--sa-surface-2)",
                    border: deviceMode === "desktop" ? "1px solid var(--sa-emerald)" : "1px solid var(--sa-border)",
                    borderRadius: "var(--sa-radius-sm)",
                    padding: "10px 12px",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    textAlign: "left",
                    color: "inherit",
                    transition: "all var(--sa-transition)",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 18 }}>💻</span>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>Desktop Speed</div>
                      <div className="sa-text-muted" style={{ fontSize: 11 }}>
                        Cable/Fiber baseline
                      </div>
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 18,
                      fontWeight: 700,
                      color:
                        (activeSpeedAudit?.desktop?.score ?? 0) >= 80
                          ? "var(--sa-emerald)"
                          : (activeSpeedAudit?.desktop?.score ?? 0) >= 50
                          ? "var(--sa-amber)"
                          : "var(--sa-rose)",
                    }}
                  >
                    {activeSpeedAudit?.desktop?.score ?? "--"}/100
                  </div>
                </button>
              </div>

              {/* Core Web Vitals & Gauge for Active Device */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "120px 1fr",
                  gap: 16,
                  alignItems: "center",
                  background: "var(--sa-surface-2)",
                  padding: "14px 16px",
                  borderRadius: "var(--sa-radius)",
                  border: "1px solid var(--sa-border)",
                }}
              >
                <SpeedGauge
                  score={currentVitals.score}
                  label={deviceMode === "mobile" ? "📱 Mobile" : "💻 Desktop"}
                  sublabel={
                    currentVitals.score >= 80
                      ? "Fast Experience"
                      : currentVitals.score >= 50
                      ? "Average Speed"
                      : "Needs Tuning"
                  }
                  size={105}
                />

                <div className="sa-vitals-grid">
                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-emerald)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      LCP (Largest Paint)
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {currentVitals.lcp}s
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>Target: &lt; 2.5s</div>
                  </div>

                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-teal)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      INP (Responsiveness)
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {currentVitals.inp}ms
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>Target: &lt; 200ms</div>
                  </div>

                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-purple)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      CLS (Layout Shift)
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {currentVitals.cls}
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>Target: &lt; 0.10</div>
                  </div>

                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-indigo)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      Load Time
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {currentVitals.loadTime}s
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>Full interactivity</div>
                  </div>

                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-amber)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      Theme Weight
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {(currentVitals.pageSize / 1024).toFixed(1)} MB
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>
                      JS: {currentVitals.jsSize}KB · CSS: {currentVitals.cssSize}KB
                    </div>
                  </div>

                  <div className="sa-vital-box" style={{ borderLeftColor: "var(--sa-cyan)" }}>
                    <div className="sa-text-muted" style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase" }}>
                      Third-Party Scripts
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>
                      {currentVitals.thirdPartyCount} apps
                    </div>
                    <div className="sa-text-muted" style={{ fontSize: 10 }}>External tags</div>
                  </div>
                </div>
              </div>

              {/* Theme Bottlenecks & Fix Recommendations */}
              {activeSpeedAudit?.bottlenecks && activeSpeedAudit.bottlenecks.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: "var(--sa-text-muted)", textTransform: "uppercase" }}>
                    Detected Theme Bottlenecks & Fixes
                  </div>
                  {activeSpeedAudit.bottlenecks.map((b, idx) => (
                    <div
                      key={idx}
                      style={{
                        background: "var(--sa-surface-2)",
                        border: "1px solid var(--sa-border)",
                        borderRadius: "var(--sa-radius-sm)",
                        padding: "10px 14px",
                        display: "flex",
                        flexDirection: "column",
                        gap: 4,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--sa-text)" }}>
                          {b.title}
                        </div>
                        <span
                          className={`sa-badge ${
                            b.impact === "HIGH" ? "critical" : b.impact === "MEDIUM" ? "warning" : "notice"
                          }`}
                          style={{ fontSize: 10 }}
                        >
                          {b.impact} IMPACT
                        </span>
                      </div>
                      <div className="sa-text-muted" style={{ fontSize: 12 }}>
                        {b.desc}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--sa-emerald)", marginTop: 2, fontWeight: 500 }}>
                        💡 Solution: {b.solution}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Catalog Diagnostic Health Summary */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Catalog Diagnostic Health</div>
              <span
                className={`sa-badge ${
                  health.score >= 80 ? "success" : health.score >= 50 ? "warning" : "critical"
                }`}
              >
                {health.score >= 80 ? "Catalog Good" : health.score >= 50 ? "Needs Review" : "Critical"}
              </span>
            </div>
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
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-purple)" }}>
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
              <Link
                to="/app/problems"
                className="sa-btn sa-btn-ghost"
                style={{ padding: "4px 10px", fontSize: 12 }}
              >
                View all ({health.total}) →
              </Link>
            </div>
            <div className="sa-card-body no-pad">
              {visibleProblems.length > 0 ? (
                visibleProblems.map((prob) => {
                  const severityClass =
                    prob.severity === "CRITICAL"
                      ? "critical"
                      : prob.severity === "WARNING"
                      ? "warning"
                      : "notice";
                  const fixClass = prob.fixType === "APP_FIX" ? "app-fix" : "dev-fix";
                  const isAppFix = prob.fixType === "APP_FIX";
                  const isThisFixing =
                    actionFetcher.state === "submitting" &&
                    actionFetcher.formData?.get("problemId") === prob.id;

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
                          marginTop: 8,
                          flexWrap: "wrap",
                          gap: 6,
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
                              {isThisFixing ? "Fixing..." : "⚡ Quick Fix"}
                            </button>
                          )}
                          <button
                            onClick={() => handleIgnoreProblem(prob.id)}
                            disabled={actionFetcher.state === "submitting"}
                            className="sa-btn sa-btn-ghost"
                            style={{ padding: "3px 7px", fontSize: 11 }}
                            title="Dismiss issue from active queue"
                          >
                            Dismiss
                          </button>
                          {(prob.resourceId || prob.resourceUrl) && (
                            <a
                              href={getShopifyAdminUrl(shop, prob.resourceType || "products", prob.resourceId || prob.resourceUrl)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="sa-btn sa-btn-secondary"
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
          Unable to load dashboard
        </div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while fetching analytics."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
