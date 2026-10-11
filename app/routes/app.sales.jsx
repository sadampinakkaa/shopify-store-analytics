import { useState } from "react";
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
  if (val == null) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val);
}

function fmtNum(val) {
  if (val == null) return "0";
  return new Intl.NumberFormat("en-US").format(val);
}

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const url = new URL(request.url);
  const since = url.searchParams.get("since") || "-30d";

  const periodDates = getPeriodDates(since);
  // Fetch from previous period start to calculate growth rates
  const orders = await fetchStoreOrders(admin, periodDates.previousStartDate);
  const { kpi, trendRows } = computeSalesAnalytics(orders, periodDates);

  return { since, kpi, trendRows };
};

export default function SalesPage() {
  const { since, kpi, trendRows } = useLoaderData();
  const revalidator = useRevalidator();

  const [activePeriod, setActivePeriod] = useState(
    DATE_RANGES.findIndex((r) => r.sinceExpr === since) !== -1
      ? DATE_RANGES.findIndex((r) => r.sinceExpr === since)
      : 1
  );

  const handlePeriodChange = (idx) => {
    setActivePeriod(idx);
    const { sinceExpr } = DATE_RANGES[idx];
    const url = new URL(window.location.href);
    url.searchParams.set("since", sinceExpr);
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  const revenueVals = trendRows.map((r) => r.gross_sales);
  const maxRevenue = Math.max(...revenueVals, 1);

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Sales Analytics</div>
          <div className="sa-page-subtitle">Revenue, orders, units sold, and period growth</div>
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
        </div>
      </div>

      {/* KPI Cards */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Gross Revenue</div>
          <div className="sa-metric-value">{fmtMoney(kpi.grossSales)}</div>
          {kpi.revenueGrowth != null && (
            <span className={`sa-metric-delta ${kpi.revenueGrowth >= 0 ? "up" : "down"}`}>
              {kpi.revenueGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.revenueGrowth)}% vs prev period
            </span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Net Sales</div>
          <div className="sa-metric-value">{fmtMoney(kpi.netSales)}</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Orders</div>
          <div className="sa-metric-value">{fmtNum(kpi.orders)}</div>
          {kpi.orderGrowth != null && (
            <span className={`sa-metric-delta ${kpi.orderGrowth >= 0 ? "up" : "down"}`}>
              {kpi.orderGrowth >= 0 ? "↑" : "↓"} {Math.abs(kpi.orderGrowth)}% vs prev period
            </span>
          )}
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Units Sold</div>
          <div className="sa-metric-value">{fmtNum(kpi.unitsSold)}</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Average Order Value</div>
          <div className="sa-metric-value">{fmtMoney(kpi.aov)}</div>
        </div>
      </div>

      {/* Revenue Trend Chart Card */}
      <div className="sa-card" style={{ marginTop: "var(--sa-space-6)" }}>
        <div className="sa-card-header">
          <div className="sa-card-title">Daily Sales Trend</div>
          <span className="sa-badge neutral">{DATE_RANGES[activePeriod]?.label}</span>
        </div>
        <div className="sa-card-body">
          {trendRows.length > 0 ? (
            <div style={{ width: "100%", height: 260 }}>
              <svg viewBox="0 0 800 240" preserveAspectRatio="none" style={{ width: "100%", height: "100%" }}>
                <defs>
                  <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity="0.3" />
                    <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                  </linearGradient>
                </defs>
                {(() => {
                  const pts = trendRows
                    .map((r, i) => {
                      const x = (i / Math.max(trendRows.length - 1, 1)) * 760 + 20;
                      const y = 220 - (r.gross_sales / maxRevenue) * 190;
                      return `${x},${y}`;
                    })
                    .join(" ");

                  const areaBase = `20,220 ${pts} ${((trendRows.length - 1) / Math.max(trendRows.length - 1, 1)) * 760 + 20},220`;

                  return (
                    <>
                      <polygon points={areaBase} fill="url(#salesGrad)" />
                      <polyline
                        points={pts}
                        fill="none"
                        stroke="#10b981"
                        strokeWidth="2.5"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    </>
                  );
                })()}
              </svg>
            </div>
          ) : (
            <div className="sa-empty">
              <div className="sa-empty-icon">📊</div>
              <div className="sa-empty-title">No orders recorded in this period</div>
              <div className="sa-empty-body">
                When new sales occur, your revenue curve and day-by-day performance will populate here.
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Daily Breakdown Table */}
      {trendRows.length > 0 && (
        <div className="sa-card" style={{ marginTop: "var(--sa-space-6)" }}>
          <div className="sa-card-header">
            <div className="sa-card-title">Daily Sales Breakdown</div>
            <span className="sa-badge success">{trendRows.length} active days</span>
          </div>
          <div className="sa-card-body no-pad">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Gross Sales</th>
                  <th>Net Sales</th>
                  <th>Orders</th>
                  <th>Units</th>
                </tr>
              </thead>
              <tbody>
                {trendRows
                  .slice()
                  .reverse()
                  .map((row) => (
                    <tr key={row.day}>
                      <td style={{ fontWeight: 600 }}>{row.day}</td>
                      <td>{fmtMoney(row.gross_sales)}</td>
                      <td>{fmtMoney(row.net_sales)}</td>
                      <td>{fmtNum(row.orders)}</td>
                      <td>{fmtNum(row.units)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <div className="sa-page sa-fade-in">
      <div className="sa-card" style={{ padding: "var(--sa-space-6)", maxWidth: 640, margin: "40px auto", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load sales data</div>
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
