import { useState, useMemo } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActionAdmin } from "../services/auth.server.js";
import {
  getPeriodDates,
  fetchStoreOrders,
  computeSalesAnalytics,
} from "../services/analytics.server";
import { syncStoreSalesHistory } from "../services/sync.server";

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

function fmtPct(val) {
  if (val == null || isNaN(val)) return "0%";
  return `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
}

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const since = url.searchParams.get("since") || "-30d";

  const periodDates = getPeriodDates(since);
  // Fetch from previous period start to calculate period-over-period growth rates
  const orders = await fetchStoreOrders(admin, periodDates.previousStartDate);
  const analytics = computeSalesAnalytics(orders, periodDates);

  return {
    shop: session.shop,
    since,
    periodDates,
    ...analytics,
  };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const { admin, session, shop } = await getActionAdmin(request, formData);
  const intent = formData.get("intent");

  if (intent === "sync_sales") {
    try {
      const days = parseInt(formData.get("days") || "30", 10);
      const result = await syncStoreSalesHistory(admin, shop, days);
      return {
        success: true,
        message: `Synced ${result.ordersSynced} orders across ${result.daysSynced} days into database snapshot.`,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to sync sales data." };
    }
  }

  if (intent === "dismiss_anomaly") {
    const anomalyId = formData.get("anomalyId");
    return {
      success: true,
      message: `Anomaly ${anomalyId} acknowledged.`,
      dismissedId: anomalyId,
    };
  }

  return { success: false, error: "Invalid action intent" };
};

export default function SalesPage() {
  const {
    shop,
    since,
    periodDates,
    kpi,
    prevPeriod,
    trendRows,
    dayOfWeekBreakdown,
    recentOrders = [],
    summary,
    anomalies: initialAnomalies = [],
  } = useLoaderData();

  const [searchParams, setSearchParams] = useSearchParams();
  const syncFetcher = useFetcher();
  const dismissFetcher = useFetcher();

  const [dismissedAnomalies, setDismissedAnomalies] = useState([]);
  const anomalies = initialAnomalies.filter((a) => !dismissedAnomalies.includes(a.id));

  const activePeriod = DATE_RANGES.findIndex((r) => r.sinceExpr === since) !== -1
    ? DATE_RANGES.findIndex((r) => r.sinceExpr === since)
    : 1;

  // Chart Metric Mode: "gross_sales" | "orders" | "units" | "aov"
  const [chartMetric, setChartMetric] = useState("gross_sales");

  // Tab View for Data Exploration: "daily" | "orders"
  const [dataTab, setDataTab] = useState("daily");

  // Daily Table filters & sorting
  const [tableSearch, setTableSearch] = useState("");
  const [sortField, setSortField] = useState("day");
  const [sortDir, setSortDir] = useState("desc"); // 'asc' | 'desc'

  // Orders Drilldown filters & sorting
  const [orderSearch, setOrderSearch] = useState("");
  const [financialFilter, setFinancialFilter] = useState("ALL");

  const handlePeriodChange = (idx) => {
    const { sinceExpr } = DATE_RANGES[idx];
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("since", sinceExpr);
      return next;
    });
  };

  const handleSyncData = () => {
    syncFetcher.submit(
      { intent: "sync_sales", days: String(periodDates.days || 30), shop: shop || "" },
      { method: "POST" }
    );
  };

  const handleDismissAnomaly = (id) => {
    setDismissedAnomalies((prev) => [...prev, id]);
    dismissFetcher.submit(
      { intent: "dismiss_anomaly", anomalyId: id, shop: shop || "" },
      { method: "POST" }
    );
  };

  // Filter and sort daily trend rows
  const filteredRows = useMemo(() => {
    let result = [...trendRows];
    if (tableSearch.trim()) {
      const q = tableSearch.toLowerCase().trim();
      result = result.filter((r) => r.day.toLowerCase().includes(q));
    }
    result.sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];
      if (typeof valA === "string") {
        return sortDir === "asc"
          ? valA.localeCompare(valB)
          : valB.localeCompare(valA);
      }
      return sortDir === "asc" ? valA - valB : valB - valA;
    });
    return result;
  }, [trendRows, tableSearch, sortField, sortDir]);

  // Filter recent orders
  const filteredOrders = useMemo(() => {
    let list = [...recentOrders];
    if (orderSearch.trim()) {
      const q = orderSearch.toLowerCase().trim();
      list = list.filter(
        (o) =>
          o.name.toLowerCase().includes(q) ||
          (o.customerName && o.customerName.toLowerCase().includes(q))
      );
    }
    if (financialFilter !== "ALL") {
      list = list.filter((o) => (o.financialStatus || "").toUpperCase() === financialFilter);
    }
    return list;
  }, [recentOrders, orderSearch, financialFilter]);

  const toggleSort = (field) => {
    if (sortField === field) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortField(field);
      setSortDir("desc");
    }
  };

  // CSV export handler
  const handleExportCSV = () => {
    if (!trendRows.length) return;
    const headers = ["Date", "Gross Sales", "Net Sales", "Orders", "Units Sold", "AOV"];
    const rows = trendRows.map((r) => [
      r.day,
      r.gross_sales,
      r.net_sales,
      r.orders,
      r.units,
      r.aov,
    ]);
    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...rows.map((e) => e.join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `store_sales_${since}_report.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  // Chart values based on chosen metric
  const chartValues = trendRows.map((r) => r[chartMetric] || 0);
  const maxChartVal = Math.max(...chartValues, 1);
  const metricLabels = {
    gross_sales: { label: "Gross Sales", prefix: "$", color: "var(--sa-emerald)", gradId: "salesGrad" },
    net_sales: { label: "Net Sales", prefix: "$", color: "var(--sa-teal)", gradId: "netGrad" },
    orders: { label: "Orders", prefix: "", color: "var(--sa-indigo)", gradId: "ordGrad" },
    units: { label: "Units Sold", prefix: "", color: "var(--sa-purple)", gradId: "unitGrad" },
    aov: { label: "Avg Order Value", prefix: "$", color: "var(--sa-amber)", gradId: "aovGrad" },
  };

  const activeMetricCfg = metricLabels[chartMetric] || metricLabels.gross_sales;
  const isSyncing = syncFetcher.state === "submitting";

  const dowSales = dayOfWeekBreakdown?.map((d) => d.gross_sales) || [];
  const maxDowSales = Math.max(...dowSales, 1);

  return (
    <div className="sa-page sa-fade-in">
      {/* Page Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Sales Analytics & Order Intelligence</div>
          <div className="sa-page-subtitle">
            Track gross & net revenues, average order value, order velocity, and daily growth drivers
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
            onClick={handleSyncData}
            disabled={isSyncing}
            className="sa-btn sa-btn-secondary"
            style={{ fontSize: 12, padding: "5px 12px" }}
            title="Sync latest orders and update database snapshots"
          >
            {isSyncing ? "⚡ Syncing..." : "⚡ Sync Data"}
          </button>
          <button
            onClick={handleExportCSV}
            className="sa-btn sa-btn-secondary"
            style={{ fontSize: 12, padding: "5px 12px" }}
            title="Download CSV report"
          >
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Action Notification Toast */}
      {syncFetcher.data && (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-5)",
            padding: "12px 16px",
            borderColor: syncFetcher.data.success ? "var(--sa-emerald)" : "var(--sa-rose)",
            background: syncFetcher.data.success ? "rgba(16,185,129,0.08)" : "rgba(244,63,94,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{syncFetcher.data.success ? "✅" : "⚠️"}</span>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {syncFetcher.data.message || syncFetcher.data.error}
            </div>
          </div>
          <button
            onClick={() => (syncFetcher.data = null)}
            className="sa-btn sa-btn-ghost"
            style={{ padding: "2px 8px", fontSize: 11 }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* KPI Cards Row */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Gross Sales</div>
          <div className="sa-metric-value">{fmtMoney(kpi.grossSales)}</div>
          {kpi.revenueGrowth != null ? (
            <span className={`sa-metric-delta ${kpi.revenueGrowth >= 0 ? "up" : "down"}`}>
              {kpi.revenueGrowth >= 0 ? "↑" : "↓"} {fmtPct(kpi.revenueGrowth)} vs prev
            </span>
          ) : (
            <span className="sa-metric-delta neutral">Period baseline</span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-teal)" }}>
          <div className="sa-metric-label">Net Sales</div>
          <div className="sa-metric-value">{fmtMoney(kpi.netSales)}</div>
          <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
            Discounts/returns: {fmtMoney(kpi.grossSales - kpi.netSales)}
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Total Orders</div>
          <div className="sa-metric-value">{fmtNum(kpi.orders)}</div>
          {kpi.orderGrowth != null ? (
            <span className={`sa-metric-delta ${kpi.orderGrowth >= 0 ? "up" : "down"}`}>
              {kpi.orderGrowth >= 0 ? "↑" : "↓"} {fmtPct(kpi.orderGrowth)} vs prev
            </span>
          ) : (
            <span className="sa-metric-delta neutral">Period baseline</span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-purple)" }}>
          <div className="sa-metric-label">Units Sold</div>
          <div className="sa-metric-value">{fmtNum(kpi.unitsSold)}</div>
          <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
            Avg {kpi.itemsPerOrder} items / order
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Average Order Value</div>
          <div className="sa-metric-value">{fmtMoney(kpi.aov)}</div>
          {kpi.aovGrowth != null ? (
            <span className={`sa-metric-delta ${kpi.aovGrowth >= 0 ? "up" : "down"}`}>
              {kpi.aovGrowth >= 0 ? "↑" : "↓"} {fmtPct(kpi.aovGrowth)} vs prev
            </span>
          ) : (
            <span className="sa-metric-delta neutral">Period baseline</span>
          )}
        </div>
      </div>

      {/* Detected Sales Anomalies Banner */}
      {anomalies.length > 0 && (
        <div style={{ marginBottom: "var(--sa-space-6)" }}>
          {anomalies.map((anom) => (
            <div
              key={anom.id}
              className="sa-card"
              style={{
                marginBottom: "var(--sa-space-3)",
                padding: "14px 18px",
                borderLeft: "4px solid var(--sa-amber)",
                background: "rgba(245, 158, 11, 0.04)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 16,
              }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                <span style={{ fontSize: 20 }}>⚠️</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14, color: "var(--sa-amber)" }}>
                    {anom.title}
                  </div>
                  <div style={{ fontSize: 13, marginTop: 2, color: "var(--sa-text)" }}>
                    {anom.description}
                  </div>
                  <div className="sa-text-muted sa-text-small" style={{ marginTop: 2 }}>
                    {anom.whyItMatters}
                  </div>
                </div>
              </div>
              <button
                onClick={() => handleDismissAnomaly(anom.id)}
                className="sa-btn sa-btn-secondary"
                style={{ fontSize: 11, padding: "4px 10px", whiteSpace: "nowrap" }}
              >
                Acknowledge
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Main Interactive Chart Card */}
      <div className="sa-card">
        <div className="sa-card-header">
          <div>
            <div className="sa-card-title">Sales Trajectory & Order Dynamics</div>
            <div className="sa-text-muted sa-text-small">
              Daily trend analysis across the selected {periodDates.days}-day window
            </div>
          </div>
          <div className="sa-tabs" style={{ marginBottom: 0 }}>
            {Object.keys(metricLabels).map((k) => (
              <button
                key={k}
                className={`sa-tab${chartMetric === k ? " active" : ""}`}
                onClick={() => setChartMetric(k)}
                style={{ fontSize: 12, padding: "4px 12px" }}
              >
                {metricLabels[k].label}
              </button>
            ))}
          </div>
        </div>

        <div className="sa-card-body">
          {trendRows.length > 1 ? (
            <div style={{ width: "100%", height: 260, position: "relative" }}>
              <svg width="100%" height="100%" viewBox="0 0 800 240" preserveAspectRatio="none">
                <defs>
                  <linearGradient id={activeMetricCfg.gradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={activeMetricCfg.color} stopOpacity="0.3" />
                    <stop offset="100%" stopColor={activeMetricCfg.color} stopOpacity="0.0" />
                  </linearGradient>
                </defs>

                {/* Horizontal reference grid lines */}
                {[0.2, 0.4, 0.6, 0.8].map((ratio) => (
                  <line
                    key={ratio}
                    x1="40"
                    y1={210 * (1 - ratio) + 10}
                    x2="780"
                    y2={210 * (1 - ratio) + 10}
                    stroke="var(--sa-border-subtle)"
                    strokeDasharray="4 4"
                    strokeWidth="1"
                  />
                ))}

                {/* Area Gradient Fill */}
                <polygon
                  points={`40,220 ${trendRows
                    .map((r, i) => {
                      const x = 40 + (i / Math.max(trendRows.length - 1, 1)) * 740;
                      const y = 220 - ((r[chartMetric] || 0) / maxChartVal) * 200;
                      return `${x},${y}`;
                    })
                    .join(" ")} 780,220`}
                  fill={`url(#${activeMetricCfg.gradId})`}
                />

                {/* Main Curve Line */}
                <polyline
                  points={trendRows
                    .map((r, i) => {
                      const x = 40 + (i / Math.max(trendRows.length - 1, 1)) * 740;
                      const y = 220 - ((r[chartMetric] || 0) / maxChartVal) * 200;
                      return `${x},${y}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke={activeMetricCfg.color}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />

                {/* Interactive Data Point Dots */}
                {trendRows.map((r, i) => {
                  const x = 40 + (i / Math.max(trendRows.length - 1, 1)) * 740;
                  const y = 220 - ((r[chartMetric] || 0) / maxChartVal) * 200;
                  return (
                    <circle
                      key={r.day}
                      cx={x}
                      cy={y}
                      r="4"
                      fill="var(--sa-surface-1)"
                      stroke={activeMetricCfg.color}
                      strokeWidth="2"
                    >
                      <title>{`${r.day}: ${activeMetricCfg.prefix}${r[chartMetric]}`}</title>
                    </circle>
                  );
                })}
              </svg>

              {/* X-axis date endpoints */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "0 40px",
                  marginTop: 6,
                  fontSize: 11,
                  color: "var(--sa-text-muted)",
                }}
              >
                <span>{trendRows[0]?.day}</span>
                <span>{trendRows[Math.floor(trendRows.length / 2)]?.day}</span>
                <span>{trendRows[trendRows.length - 1]?.day}</span>
              </div>
            </div>
          ) : (
            <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
              <div className="sa-empty-icon">📊</div>
              <div className="sa-empty-title">Insufficient Sales Points</div>
              <div className="sa-empty-body">
                Expand your date filter or sync orders to view trajectory trends.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Two-Column Insights Grid: Day of Week Analysis & Period Comparison */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: "var(--sa-space-6)",
          marginTop: "var(--sa-space-6)",
        }}
      >
        {/* Day-of-Week Sales Performance */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Day of Week Performance</div>
              <div className="sa-text-muted sa-text-small">
                Identify peak buying days to optimize ad scheduling and email blasts
              </div>
            </div>
            {summary.bestDayName && (
              <span className="sa-badge success">Best: {summary.bestDayName}</span>
            )}
          </div>
          <div className="sa-card-body">
            <div style={{ display: "grid", gap: "var(--sa-space-3)" }}>
              {dayOfWeekBreakdown?.map((dow) => {
                const barWidth = maxDowSales > 0 ? (dow.gross_sales / maxDowSales) * 100 : 0;
                const isBest = dow.dayName === summary.bestDayName;
                return (
                  <div
                    key={dow.dayName}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "70px 1fr 110px",
                      alignItems: "center",
                      gap: 12,
                    }}
                  >
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: isBest ? 700 : 500,
                        color: isBest ? "var(--sa-emerald)" : "var(--sa-text)",
                      }}
                    >
                      {dow.dayName.slice(0, 3)}
                    </div>
                    <div
                      style={{
                        background: "var(--sa-surface-3)",
                        borderRadius: 4,
                        height: 16,
                        overflow: "hidden",
                        position: "relative",
                      }}
                    >
                      <div
                        style={{
                          width: `${Math.max(barWidth, 3)}%`,
                          height: "100%",
                          background: isBest ? "var(--sa-emerald)" : "var(--sa-indigo)",
                          borderRadius: 4,
                          transition: "width 0.4s ease",
                        }}
                      />
                    </div>
                    <div style={{ fontSize: 12, textAlign: "right", fontWeight: 600 }}>
                      {fmtMoney(dow.gross_sales)}
                      <span className="sa-text-muted" style={{ fontSize: 10, marginLeft: 4 }}>
                        ({dow.orders} ord)
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Period-Over-Period Comparison Matrix */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Period-Over-Period Comparison</div>
              <div className="sa-text-muted sa-text-small">
                Current window vs preceding equal duration
              </div>
            </div>
            <span className="sa-badge neutral">{DATE_RANGES[activePeriod]?.label}</span>
          </div>
          <div className="sa-card-body no-pad">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Metric</th>
                  <th>Current</th>
                  <th>Previous</th>
                  <th>Growth</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={{ fontWeight: 600 }}>Gross Sales</td>
                  <td>{fmtMoney(kpi.grossSales)}</td>
                  <td className="muted">{fmtMoney(prevPeriod?.grossSales)}</td>
                  <td>
                    {kpi.revenueGrowth != null ? (
                      <span className={`sa-metric-delta ${kpi.revenueGrowth >= 0 ? "up" : "down"}`}>
                        {fmtPct(kpi.revenueGrowth)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Net Sales</td>
                  <td>{fmtMoney(kpi.netSales)}</td>
                  <td className="muted">{fmtMoney(prevPeriod?.netSales)}</td>
                  <td>
                    {prevPeriod?.netSales > 0 ? (
                      <span
                        className={`sa-metric-delta ${
                          kpi.netSales >= prevPeriod.netSales ? "up" : "down"
                        }`}
                      >
                        {fmtPct(((kpi.netSales - prevPeriod.netSales) / prevPeriod.netSales) * 100)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Orders Count</td>
                  <td>{fmtNum(kpi.orders)}</td>
                  <td className="muted">{fmtNum(prevPeriod?.orders)}</td>
                  <td>
                    {kpi.orderGrowth != null ? (
                      <span className={`sa-metric-delta ${kpi.orderGrowth >= 0 ? "up" : "down"}`}>
                        {fmtPct(kpi.orderGrowth)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Units Sold</td>
                  <td>{fmtNum(kpi.unitsSold)}</td>
                  <td className="muted">{fmtNum(prevPeriod?.unitsSold)}</td>
                  <td>
                    {kpi.unitsGrowth != null ? (
                      <span className={`sa-metric-delta ${kpi.unitsGrowth >= 0 ? "up" : "down"}`}>
                        {fmtPct(kpi.unitsGrowth)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>Average Order Value</td>
                  <td>{fmtMoney(kpi.aov)}</td>
                  <td className="muted">{fmtMoney(prevPeriod?.aov)}</td>
                  <td>
                    {kpi.aovGrowth != null ? (
                      <span className={`sa-metric-delta ${kpi.aovGrowth >= 0 ? "up" : "down"}`}>
                        {fmtPct(kpi.aovGrowth)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Exploration View Switcher: Daily Trend vs Order Drill-down */}
      <div className="sa-card" style={{ marginTop: "var(--sa-space-6)" }}>
        <div className="sa-card-header">
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div className="sa-tabs" style={{ marginBottom: 0 }}>
              <button
                className={`sa-tab${dataTab === "daily" ? " active" : ""}`}
                onClick={() => setDataTab("daily")}
              >
                📅 Daily Breakdown ({filteredRows.length})
              </button>
              <button
                className={`sa-tab${dataTab === "orders" ? " active" : ""}`}
                onClick={() => setDataTab("orders")}
              >
                🛍️ Recent Orders Drill-down ({filteredOrders.length})
              </button>
            </div>
          </div>

          {dataTab === "daily" ? (
            <input
              type="text"
              placeholder="Search by date (YYYY-MM-DD)..."
              value={tableSearch}
              onChange={(e) => setTableSearch(e.target.value)}
              style={{
                background: "var(--sa-surface-2)",
                border: "1px solid var(--sa-border-subtle)",
                borderRadius: "var(--sa-radius-sm)",
                color: "var(--sa-text)",
                padding: "5px 10px",
                fontSize: 12,
                outline: "none",
                width: 200,
              }}
            />
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <select
                value={financialFilter}
                onChange={(e) => setFinancialFilter(e.target.value)}
                style={{
                  background: "var(--sa-surface-2)",
                  border: "1px solid var(--sa-border-subtle)",
                  borderRadius: "var(--sa-radius-sm)",
                  color: "var(--sa-text)",
                  padding: "5px 8px",
                  fontSize: 12,
                  outline: "none",
                }}
              >
                <option value="ALL">All Payment Statuses</option>
                <option value="PAID">Paid</option>
                <option value="PENDING">Pending</option>
                <option value="REFUNDED">Refunded</option>
              </select>
              <input
                type="text"
                placeholder="Search order # or customer..."
                value={orderSearch}
                onChange={(e) => setOrderSearch(e.target.value)}
                style={{
                  background: "var(--sa-surface-2)",
                  border: "1px solid var(--sa-border-subtle)",
                  borderRadius: "var(--sa-radius-sm)",
                  color: "var(--sa-text)",
                  padding: "5px 10px",
                  fontSize: 12,
                  outline: "none",
                  width: 200,
                }}
              />
            </div>
          )}
        </div>

        <div className="sa-card-body no-pad">
          {dataTab === "daily" ? (
            filteredRows.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("day")}
                    >
                      Date {sortField === "day" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("gross_sales")}
                    >
                      Gross Sales {sortField === "gross_sales" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("net_sales")}
                    >
                      Net Sales {sortField === "net_sales" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("orders")}
                    >
                      Orders {sortField === "orders" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("units")}
                    >
                      Units {sortField === "units" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                    <th
                      style={{ cursor: "pointer", userSelect: "none" }}
                      onClick={() => toggleSort("aov")}
                    >
                      AOV {sortField === "aov" ? (sortDir === "asc" ? "↑" : "↓") : ""}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.map((row) => (
                    <tr key={row.day}>
                      <td style={{ fontWeight: 600 }}>{row.day}</td>
                      <td style={{ fontWeight: 600, color: "var(--sa-emerald)" }}>
                        {fmtMoney(row.gross_sales)}
                      </td>
                      <td>{fmtMoney(row.net_sales)}</td>
                      <td>{fmtNum(row.orders)}</td>
                      <td>{fmtNum(row.units)}</td>
                      <td className="muted">{fmtMoney(row.aov)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                <div className="sa-empty-icon">🔍</div>
                <div className="sa-empty-title">No matching dates found</div>
                <div className="sa-empty-body">Try clearing your search query.</div>
              </div>
            )
          ) : (
            filteredOrders.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Order #</th>
                    <th>Date / Time</th>
                    <th>Customer</th>
                    <th>Items</th>
                    <th>Payment</th>
                    <th>Fulfillment</th>
                    <th>Total</th>
                    <th style={{ textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOrders.map((ord) => (
                    <tr key={ord.id}>
                      <td style={{ fontWeight: 600 }}>{ord.name}</td>
                      <td className="muted">{ord.createdAt?.slice(0, 16).replace("T", " ")}</td>
                      <td>{ord.customerName}</td>
                      <td>{ord.units} item(s)</td>
                      <td>
                        <span
                          className={`sa-badge ${
                            ord.financialStatus === "PAID" ? "success" : "warning"
                          }`}
                        >
                          {ord.financialStatus}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`sa-badge ${
                            ord.fulfillmentStatus === "FULFILLED" ? "success" : "neutral"
                          }`}
                        >
                          {ord.fulfillmentStatus}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600, color: "var(--sa-emerald)" }}>
                        {fmtMoney(ord.total)}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <a
                          href={`https://${shop}/admin/orders/${ord.numericId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="sa-btn sa-btn-secondary"
                          style={{ padding: "3px 8px", fontSize: 11 }}
                        >
                          View in Admin ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                <div className="sa-empty-icon">🛍️</div>
                <div className="sa-empty-title">No orders found in this period</div>
                <div className="sa-empty-body">
                  Orders will automatically appear here as they are placed on your storefront.
                </div>
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Sales ErrorBoundary caught error:", error);

  try {
    const shopifyBoundary = boundary.error(error);
    if (shopifyBoundary) return shopifyBoundary;
  } catch {
    // fallback
  }

  let errorMessage = "An unexpected error occurred while loading sales analytics.";
  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (error && typeof error === "object") {
    errorMessage =
      error.data?.message ||
      error.statusText ||
      (typeof error.data === "string" ? error.data : "") ||
      error.message ||
      errorMessage;
  }

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
          Unable to load sales data
        </div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {errorMessage}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
