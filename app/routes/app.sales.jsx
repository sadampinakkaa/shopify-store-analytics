import { useState, useMemo } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getPeriodDates,
  fetchStoreOrders,
  computeSalesAnalytics,
} from "../services/analytics.server";

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

export default function SalesPage() {
  const {
    shop,
    since,
    periodDates,
    kpi,
    prevPeriod,
    trendRows,
    dayOfWeekBreakdown,
    summary,
    anomalies,
  } = useLoaderData();
  const revalidator = useRevalidator();

  const [activePeriod, setActivePeriod] = useState(
    DATE_RANGES.findIndex((r) => r.sinceExpr === since) !== -1
      ? DATE_RANGES.findIndex((r) => r.sinceExpr === since)
      : 1
  );

  // Chart Metric Mode: "gross_sales" | "orders" | "units" | "aov"
  const [chartMetric, setChartMetric] = useState("gross_sales");

  // Table filters & sorting
  const [tableSearch, setTableSearch] = useState("");
  const [sortField, setSortField] = useState("day");
  const [sortDir, setSortDir] = useState("desc"); // 'asc' | 'desc'

  const handlePeriodChange = (idx) => {
    setActivePeriod(idx);
    const { sinceExpr } = DATE_RANGES[idx];
    const url = new URL(window.location.href);
    url.searchParams.set("since", sinceExpr);
    window.history.pushState({}, "", url);
    revalidator.revalidate();
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
    gross_sales: { label: "Gross Sales", prefix: "$", color: "#10b981", gradId: "salesGrad" },
    orders: { label: "Orders", prefix: "", color: "#6366f1", gradId: "ordersGrad" },
    units: { label: "Units Sold", prefix: "", color: "#8b5cf6", gradId: "unitsGrad" },
    aov: { label: "Average Order Value", prefix: "$", color: "#f59e0b", gradId: "aovGrad" },
  };
  const activeMetricCfg = metricLabels[chartMetric];

  // Highest day of week
  const maxDowSales = Math.max(...(dayOfWeekBreakdown?.map((d) => d.gross_sales) || [1]), 1);

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Sales Analytics & Anomaly Detection</div>
          <div className="sa-page-subtitle">
            Revenue velocity, order volume, period-over-period growth, and sales drop diagnostics
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
            onClick={handleExportCSV}
            className="sa-btn sa-btn-secondary"
            style={{ fontSize: 12, padding: "5px 12px" }}
            title="Export daily sales data as CSV"
          >
            📥 Export CSV
          </button>
        </div>
      </div>

      {/* Sales Problem & Anomaly Detection Banner */}
      {anomalies && anomalies.length > 0 ? (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-6)",
            borderColor: "rgba(245, 158, 11, 0.4)",
            background: "linear-gradient(180deg, rgba(245, 158, 11, 0.08) 0%, var(--sa-surface) 100%)",
          }}
        >
          <div className="sa-card-header">
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 18 }}>⚠️</span>
              <div className="sa-card-title" style={{ color: "var(--sa-amber)" }}>
                Sales Diagnostic Alerts ({anomalies.length} detected)
              </div>
            </div>
            <span className="sa-badge warning">Action Recommended</span>
          </div>
          <div className="sa-card-body" style={{ padding: "var(--sa-space-4) var(--sa-space-5)" }}>
            <div style={{ display: "grid", gap: "var(--sa-space-3)" }}>
              {anomalies.map((ano) => (
                <div
                  key={ano.id}
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    padding: "10px 14px",
                    background: "var(--sa-surface-2)",
                    borderRadius: "var(--sa-radius-sm)",
                    borderLeft: `4px solid ${
                      ano.severity === "CRITICAL"
                        ? "var(--sa-rose)"
                        : ano.severity === "WARNING"
                        ? "var(--sa-amber)"
                        : "var(--sa-cyan)"
                    }`,
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 2 }}>{ano.title}</div>
                    <div className="sa-text-muted" style={{ fontSize: 12, lineHeight: 1.4 }}>
                      {ano.description}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--sa-text-dimmed)",
                        marginTop: 4,
                        fontStyle: "italic",
                      }}
                    >
                      Impact: {ano.whyItMatters}
                    </div>
                  </div>
                  <span
                    className={`sa-badge ${
                      ano.severity === "CRITICAL"
                        ? "critical"
                        : ano.severity === "WARNING"
                        ? "warning"
                        : "notice"
                    }`}
                  >
                    {ano.type}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-6)",
            padding: "12px 18px",
            background: "rgba(16, 185, 129, 0.05)",
            border: "1px solid rgba(16, 185, 129, 0.2)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>✅</span>
            <div>
              <div style={{ fontWeight: 600, fontSize: 13, color: "var(--sa-emerald)" }}>
                Sales Health Stable
              </div>
              <div className="sa-text-muted" style={{ fontSize: 12 }}>
                No significant sales dips, zero-order anomalies, or margin leakage detected in this period.
              </div>
            </div>
          </div>
          <span className="sa-badge success">Healthy</span>
        </div>
      )}

      {/* KPI Cards Grid */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Gross Revenue</div>
          <div className="sa-metric-value">{fmtMoney(kpi.grossSales)}</div>
          {kpi.revenueGrowth != null ? (
            <span className={`sa-metric-delta ${kpi.revenueGrowth >= 0 ? "up" : "down"}`}>
              {kpi.revenueGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.revenueGrowth)}% vs prev period
            </span>
          ) : (
            <span className="sa-metric-delta neutral">Period baseline</span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Net Sales</div>
          <div className="sa-metric-value">{fmtMoney(kpi.netSales)}</div>
          <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
            {kpi.grossSales > 0
              ? `${Math.round((kpi.netSales / kpi.grossSales) * 100)}% of gross revenue`
              : "Post discounts & returns"}
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Total Orders</div>
          <div className="sa-metric-value">{fmtNum(kpi.orders)}</div>
          {kpi.orderGrowth != null ? (
            <span className={`sa-metric-delta ${kpi.orderGrowth >= 0 ? "up" : "down"}`}>
              {kpi.orderGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.orderGrowth)}% vs prev period
            </span>
          ) : (
            <span className="sa-metric-delta neutral">Period baseline</span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Units Sold</div>
          <div className="sa-metric-value">{fmtNum(kpi.unitsSold)}</div>
          {kpi.unitsGrowth != null && (
            <span className={`sa-metric-delta ${kpi.unitsGrowth >= 0 ? "up" : "down"}`}>
              {kpi.unitsGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.unitsGrowth)}%
            </span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Average Order Value</div>
          <div className="sa-metric-value">{fmtMoney(kpi.aov)}</div>
          {kpi.aovGrowth != null && (
            <span className={`sa-metric-delta ${kpi.aovGrowth >= 0 ? "up" : "down"}`}>
              {kpi.aovGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.aovGrowth)}%
            </span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-orange)" }}>
          <div className="sa-metric-label">Items Per Order</div>
          <div className="sa-metric-value">{kpi.itemsPerOrder || 0}</div>
          <div className="sa-text-muted sa-text-small" style={{ marginTop: 4 }}>
            Basket depth efficiency
          </div>
        </div>
      </div>

      {/* Interactive Sales Trend Chart Card */}
      <div className="sa-card" style={{ marginTop: "var(--sa-space-6)" }}>
        <div className="sa-card-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <div className="sa-card-title">Daily Sales Velocity</div>
            {summary.peakDay && (
              <span className="sa-badge success" style={{ textTransform: "none" }}>
                🏆 Peak: {fmtMoney(summary.peakDay.gross_sales)} ({summary.peakDay.day})
              </span>
            )}
            {summary.avgDailySales > 0 && (
              <span className="sa-badge neutral" style={{ textTransform: "none" }}>
                Avg: {fmtMoney(summary.avgDailySales)} / day
              </span>
            )}
          </div>

          {/* Metric Selector Pills */}
          <div className="sa-date-pills">
            <button
              className={`sa-date-pill${chartMetric === "gross_sales" ? " active" : ""}`}
              onClick={() => setChartMetric("gross_sales")}
            >
              Revenue ($)
            </button>
            <button
              className={`sa-date-pill${chartMetric === "orders" ? " active" : ""}`}
              onClick={() => setChartMetric("orders")}
            >
              Orders
            </button>
            <button
              className={`sa-date-pill${chartMetric === "units" ? " active" : ""}`}
              onClick={() => setChartMetric("units")}
            >
              Units
            </button>
            <button
              className={`sa-date-pill${chartMetric === "aov" ? " active" : ""}`}
              onClick={() => setChartMetric("aov")}
            >
              AOV ($)
            </button>
          </div>
        </div>

        <div className="sa-card-body">
          {trendRows.length > 0 ? (
            <div>
              <div style={{ width: "100%", height: 260, position: "relative" }}>
                <svg
                  viewBox="0 0 800 240"
                  preserveAspectRatio="none"
                  style={{ width: "100%", height: "100%" }}
                >
                  <defs>
                    <linearGradient id={activeMetricCfg.gradId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={activeMetricCfg.color} stopOpacity="0.35" />
                      <stop offset="100%" stopColor={activeMetricCfg.color} stopOpacity="0.0" />
                    </linearGradient>
                  </defs>

                  {/* Horizontal grid guide lines */}
                  <line x1="20" y1="30" x2="780" y2="30" stroke="var(--sa-border-subtle)" strokeDasharray="4 4" />
                  <line x1="20" y1="125" x2="780" y2="125" stroke="var(--sa-border-subtle)" strokeDasharray="4 4" />
                  <line x1="20" y1="220" x2="780" y2="220" stroke="var(--sa-border-subtle)" />

                  {(() => {
                    const pts = trendRows
                      .map((r, i) => {
                        const val = r[chartMetric] || 0;
                        const x = (i / Math.max(trendRows.length - 1, 1)) * 760 + 20;
                        const y = 220 - (val / maxChartVal) * 190;
                        return `${x},${y}`;
                      })
                      .join(" ");

                    const areaBase = `20,220 ${pts} ${
                      ((trendRows.length - 1) / Math.max(trendRows.length - 1, 1)) * 760 + 20
                    },220`;

                    return (
                      <>
                        <polygon points={areaBase} fill={`url(#${activeMetricCfg.gradId})`} />
                        <polyline
                          points={pts}
                          fill="none"
                          stroke={activeMetricCfg.color}
                          strokeWidth="2.5"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        {/* Point circles */}
                        {trendRows.map((r, i) => {
                          const val = r[chartMetric] || 0;
                          const cx = (i / Math.max(trendRows.length - 1, 1)) * 760 + 20;
                          const cy = 220 - (val / maxChartVal) * 190;
                          return (
                            <circle
                              key={r.day}
                              cx={cx}
                              cy={cy}
                              r={trendRows.length > 30 ? 2 : 4}
                              fill={activeMetricCfg.color}
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

              {/* X Axis Labels */}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  color: "var(--sa-text-dimmed)",
                  marginTop: 6,
                  padding: "0 10px",
                }}
              >
                <span>{trendRows[0]?.day}</span>
                {trendRows.length > 2 && (
                  <span>{trendRows[Math.floor(trendRows.length / 2)]?.day}</span>
                )}
                <span>{trendRows[trendRows.length - 1]?.day}</span>
              </div>
            </div>
          ) : (
            <div className="sa-empty">
              <div className="sa-empty-icon">📊</div>
              <div className="sa-empty-title">No orders recorded in this timeframe</div>
              <div className="sa-empty-body">
                When new transactions occur, your daily sales curve and performance breakdown will populate here.
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
                  <div key={dow.dayName} style={{ display: "grid", gridTemplateColumns: "70px 1fr 90px", alignItems: "center", gap: 12 }}>
                    <div style={{ fontSize: 12, fontWeight: isBest ? 700 : 500, color: isBest ? "var(--sa-emerald)" : "var(--sa-text)" }}>
                      {dow.dayName.slice(0, 3)}
                    </div>
                    <div style={{ background: "var(--sa-surface-3)", borderRadius: 4, height: 16, overflow: "hidden", position: "relative" }}>
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

      {/* Daily Breakdown Table with Live Search & Sort */}
      <div className="sa-card" style={{ marginTop: "var(--sa-space-6)" }}>
        <div className="sa-card-header">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="sa-card-title">Daily Sales Breakdown</div>
            <span className="sa-badge success">{filteredRows.length} active day(s)</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
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
          </div>
        </div>
        <div className="sa-card-body no-pad">
          {filteredRows.length > 0 ? (
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
          )}
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
          Unable to load sales data
        </div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while loading sales analytics."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
