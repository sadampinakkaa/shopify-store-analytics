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
    ...data.geoMetrics,
  };
};

export default function GeographyPage() {
  const { periodDays, countries, provinces, cities, totalOrders, totalRevenue } =
    useLoaderData();
  const revalidator = useRevalidator();

  const [activeTab, setActiveTab] = useState("country"); // 'country' | 'province' | 'city'

  const handlePeriodChange = (days) => {
    const url = new URL(window.location.href);
    url.searchParams.set("days", days.toString());
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  const topCountry = countries[0]?.name || "Local Market";

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Geographic Sales Analytics</div>
          <div className="sa-page-subtitle">
            Sales, orders, and delivery destinations mapped by country, state, and city
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
          <div className="sa-metric-label">Primary Market</div>
          <div className="sa-metric-value" style={{ fontSize: 22 }}>
            {topCountry}
          </div>
          <div className="sa-text-muted sa-text-small">
            {countries[0]?.share || "100"}% of period revenue
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Active Countries</div>
          <div className="sa-metric-value">{countries.length}</div>
          <div className="sa-text-muted sa-text-small">International territories served</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Domestic Regions</div>
          <div className="sa-metric-value">{provinces.length}</div>
          <div className="sa-text-muted sa-text-small">States / provinces shipping</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Total Geo Revenue</div>
          <div className="sa-metric-value">{fmtMoney(totalRevenue)}</div>
          <div className="sa-text-muted sa-text-small">Across {fmtNum(totalOrders)} orders</div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)" }}>
        <button
          className={`sa-date-pill${activeTab === "country" ? " active" : ""}`}
          onClick={() => setActiveTab("country")}
        >
          🌍 Country Breakdown ({countries.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "province" ? " active" : ""}`}
          onClick={() => setActiveTab("province")}
        >
          📍 State / Region ({provinces.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "city" ? " active" : ""}`}
          onClick={() => setActiveTab("city")}
        >
          🏙️ Top Metro Cities ({cities.length})
        </button>
      </div>

      {/* Tab 1: Country Breakdown */}
      {activeTab === "country" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Country & Market Concentration</div>
            <span className="sa-badge success">{countries.length} Countries</span>
          </div>
          <div className="sa-card-body no-pad">
            {countries.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Country</th>
                    <th>Orders</th>
                    <th>Gross Sales</th>
                    <th>Market Share</th>
                    <th>Visual Distribution</th>
                  </tr>
                </thead>
                <tbody>
                  {countries.map((c) => (
                    <tr key={c.name}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td>{fmtNum(c.orders)}</td>
                      <td style={{ fontWeight: 600, color: "var(--sa-emerald)" }}>{fmtMoney(c.revenue)}</td>
                      <td>
                        <span className="sa-badge neutral">{c.share}%</span>
                      </td>
                      <td style={{ width: 220 }}>
                        <div style={{ width: "100%", height: 8, background: "var(--sa-surface-3)", borderRadius: 4, overflow: "hidden" }}>
                          <div style={{ width: `${c.share}%`, height: "100%", background: "var(--sa-emerald)" }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">🌍</div>
                <div className="sa-empty-title">No location data for this window</div>
                <div className="sa-empty-body">
                  Orders will automatically be mapped by country and shipping jurisdiction.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Provinces */}
      {activeTab === "province" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">State / Province Performance</div>
            <span className="sa-badge neutral">Top 15 Regions</span>
          </div>
          <div className="sa-card-body no-pad">
            {provinces.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>State / Province</th>
                    <th>Country</th>
                    <th>Orders</th>
                    <th>Revenue</th>
                    <th>Regional Share</th>
                  </tr>
                </thead>
                <tbody>
                  {provinces.map((p, idx) => (
                    <tr key={`${p.name}-${idx}`}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.country}</td>
                      <td>{fmtNum(p.orders)}</td>
                      <td style={{ fontWeight: 600, color: "var(--sa-cyan)" }}>{fmtMoney(p.revenue)}</td>
                      <td>
                        <span className="sa-badge neutral">{p.share}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">📍</div>
                <div className="sa-empty-title">No state or province data available</div>
                <div className="sa-empty-body">Once customer deliveries occur, regions will appear here.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Cities */}
      {activeTab === "city" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Top Metro Destination Cities</div>
            <span className="sa-badge neutral">Top 15 Cities</span>
          </div>
          <div className="sa-card-body no-pad">
            {cities.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>City</th>
                    <th>Region / Country</th>
                    <th>Orders</th>
                    <th>Revenue</th>
                    <th>City Share</th>
                  </tr>
                </thead>
                <tbody>
                  {cities.map((ct, idx) => (
                    <tr key={`${ct.name}-${idx}`}>
                      <td style={{ fontWeight: 600 }}>{ct.name}</td>
                      <td>
                        {ct.province}, {ct.country}
                      </td>
                      <td>{fmtNum(ct.orders)}</td>
                      <td style={{ fontWeight: 600, color: "var(--sa-indigo)" }}>{fmtMoney(ct.revenue)}</td>
                      <td>
                        <span className="sa-badge neutral">{ct.share}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">🏙️</div>
                <div className="sa-empty-title">No city records found</div>
                <div className="sa-empty-body">Top delivery cities will populate from customer orders.</div>
              </div>
            )}
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load geographic analytics</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing order geography."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
