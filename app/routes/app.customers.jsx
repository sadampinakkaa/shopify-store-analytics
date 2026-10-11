import { useState } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { fetchCustomerAndGeoData } from "../services/customer_geo.server";

const PERIODS = [
  { label: "30D", days: 30 },
  { label: "90D", days: 90 },
  { label: "180D", days: 180 },
  { label: "1Y", days: 365 },
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
  const periodDays = parseInt(url.searchParams.get("days") || "30", 10);

  const data = await fetchCustomerAndGeoData(admin, periodDays);

  return {
    periodDays,
    ...data.customerMetrics,
  };
};

export default function CustomersPage() {
  const {
    periodDays,
    totalCustomers,
    newCustomers,
    returningCustomers,
    repeatPurchaseRate,
    avgCustomerValue,
    purchaseFrequency,
    totalOrders,
    totalRevenue,
  } = useLoaderData();
  const revalidator = useRevalidator();

  const handlePeriodChange = (days) => {
    const url = new URL(window.location.href);
    url.searchParams.set("days", days.toString());
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Customer Analytics & Cohorts</div>
          <div className="sa-page-subtitle">
            Acquisition volume, repeat purchase behavior, and lifetime customer value
          </div>
        </div>
        <div className="sa-inline">
          <div className="sa-date-pills">
            {PERIODS.map((p) => (
              <button
                key={p.label}
                className={`sa-date-pill${periodDays === p.days ? " active" : ""}`}
                onClick={() => handlePeriodChange(p.days)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Repeat Purchase Rate</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-emerald)" }}>
            {repeatPurchaseRate}%
          </div>
          <div className="sa-text-muted sa-text-small">
            {returningCustomers} returning / {totalCustomers} total
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">New Customers</div>
          <div className="sa-metric-value">{fmtNum(newCustomers)}</div>
          <div className="sa-text-muted sa-text-small">First-time buyers acquired</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Returning Customers</div>
          <div className="sa-metric-value">{fmtNum(returningCustomers)}</div>
          <div className="sa-text-muted sa-text-small">Repeat store patrons</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Average Customer Value</div>
          <div className="sa-metric-value">{fmtMoney(avgCustomerValue)}</div>
          <div className="sa-text-muted sa-text-small">Revenue per unique buyer</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Purchase Frequency</div>
          <div className="sa-metric-value">{purchaseFrequency}x</div>
          <div className="sa-text-muted sa-text-small">Orders per customer in {periodDays}d</div>
        </div>
      </div>

      {/* Cohort Comparison Card */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-5)", margin: "var(--sa-space-6) 0" }}>
        {/* Left: Cohort Balance */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Customer Acquisition vs Retention</div>
            <span className="sa-badge neutral">{totalCustomers} Total Buyers</span>
          </div>
          <div className="sa-card-body">
            <div style={{ marginBottom: "var(--sa-space-4)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span>🌱 First-Time Buyers</span>
                <span style={{ fontWeight: 600 }}>
                  {totalCustomers > 0 ? ((newCustomers / totalCustomers) * 100).toFixed(0) : 0}% ({newCustomers})
                </span>
              </div>
              <div style={{ width: "100%", height: 10, background: "var(--sa-surface-3)", borderRadius: 5, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${totalCustomers > 0 ? (newCustomers / totalCustomers) * 100 : 0}%`,
                    height: "100%",
                    background: "var(--sa-cyan)",
                  }}
                />
              </div>
            </div>

            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                <span>💎 Returning / Loyal Buyers</span>
                <span style={{ fontWeight: 600 }}>
                  {totalCustomers > 0 ? ((returningCustomers / totalCustomers) * 100).toFixed(0) : 0}% ({returningCustomers})
                </span>
              </div>
              <div style={{ width: "100%", height: 10, background: "var(--sa-surface-3)", borderRadius: 5, overflow: "hidden" }}>
                <div
                  style={{
                    width: `${totalCustomers > 0 ? (returningCustomers / totalCustomers) * 100 : 0}%`,
                    height: "100%",
                    background: "var(--sa-emerald)",
                  }}
                />
              </div>
            </div>

            <div style={{ marginTop: "var(--sa-space-5)", padding: "12px 14px", background: "var(--sa-surface-2)", borderRadius: 8, fontSize: 12, color: "var(--sa-text-muted)" }}>
              💡 <strong>Retention Insight:</strong> A healthy direct-to-consumer store typically aims for a 20–30% repeat customer rate. Implement post-purchase email nurture flows to increase 60-day repurchase frequency.
            </div>
          </div>
        </div>

        {/* Right: Revenue Contribution by Cohort */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Cohort Revenue Concentration</div>
            <span className="sa-badge success">{fmtMoney(totalRevenue)} Period Total</span>
          </div>
          <div className="sa-card-body">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sa-space-4)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--sa-surface-2)", borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Acquisition Revenue</div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>First transactions from new visitors</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--sa-cyan)" }}>
                    {fmtMoney(totalCustomers > 0 ? (newCustomers / totalCustomers) * totalRevenue : 0)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>
                    {totalCustomers > 0 ? ((newCustomers / totalCustomers) * 100).toFixed(0) : 0}% of revenue
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--sa-surface-2)", borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Repeat Customer Revenue</div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>Secondary and recurring orders</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--sa-emerald)" }}>
                    {fmtMoney(totalCustomers > 0 ? (returningCustomers / totalCustomers) * totalRevenue : 0)}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>
                    {totalCustomers > 0 ? ((returningCustomers / totalCustomers) * 100).toFixed(0) : 0}% of revenue
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px", background: "var(--sa-surface-2)", borderRadius: 8 }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Order Volume Breakdown</div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>Total completed checkouts</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, color: "var(--sa-indigo)" }}>
                    {fmtNum(totalOrders)} orders
                  </div>
                  <div style={{ fontSize: 11, color: "var(--sa-text-muted)" }}>Across all cohorts</div>
                </div>
              </div>
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
      <div className="sa-card" style={{ padding: "var(--sa-space-6)", maxWidth: 640, margin: "40px auto", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load customer analytics</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing customer retention."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
