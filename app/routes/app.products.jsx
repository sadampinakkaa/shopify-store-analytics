import { useState } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getPeriodDates,
  fetchStoreOrders,
  fetchStoreCatalog,
  computeProductIntelligence,
} from "../services/analytics.server";

const PERIODS = [
  { label: "30D", days: 30, sinceExpr: "-30d" },
  { label: "90D", days: 90, sinceExpr: "-90d" },
  { label: "180D", days: 180, sinceExpr: "-180d" },
  { label: "1Y", days: 365, sinceExpr: "-365d" },
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
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const periodDays = parseInt(url.searchParams.get("days") || "30", 10);
  const sinceDate = getPeriodDates(`-${periodDays}d`).currentStartDate;

  const [products, orders] = await Promise.all([
    fetchStoreCatalog(admin),
    fetchStoreOrders(admin, sinceDate),
  ]);

  const intelligence = computeProductIntelligence(products, orders, periodDays);

  return {
    shop: session.shop,
    periodDays,
    ...intelligence,
  };
};

export default function ProductsPage() {
  const { shop, periodDays, allProducts, bestSellers, leastOrdered, slowMoving } = useLoaderData();
  const revalidator = useRevalidator();

  const [activeTab, setActiveTab] = useState("bestsellers"); // 'bestsellers' | 'slowmoving' | 'leastordered' | 'funnel' | 'all'

  const handlePeriodChange = (days) => {
    const url = new URL(window.location.href);
    url.searchParams.set("days", days.toString());
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  const getStatusBadgeClass = (status) => {
    switch (status) {
      case "Healthy":
        return "sa-badge success";
      case "Slow Moving":
        return "sa-badge warning";
      case "Very Slow":
        return "sa-badge orange";
      case "Dead Stock":
        return "sa-badge critical";
      case "Out of Stock":
        return "sa-badge critical";
      default:
        return "sa-badge neutral";
    }
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Product Intelligence</div>
          <div className="sa-page-subtitle">
            Sales velocity, inventory turnover, best sellers, and slow-moving stock
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

      {/* Summary KPI Cards */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Active Catalog Products</div>
          <div className="sa-metric-value">{fmtNum(allProducts.length)}</div>
        </div>
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Products With Sales</div>
          <div className="sa-metric-value">{fmtNum(bestSellers.length)}</div>
        </div>
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Slow-Moving Stock</div>
          <div className="sa-metric-value">{fmtNum(slowMoving.length)}</div>
        </div>
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-rose)" }}>
          <div className="sa-metric-label">Dead Stock SKUs</div>
          <div className="sa-metric-value">
            {fmtNum(allProducts.filter((p) => p.velocityStatus === "Dead Stock").length)}
          </div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)" }}>
        <button
          className={`sa-date-pill${activeTab === "bestsellers" ? " active" : ""}`}
          onClick={() => setActiveTab("bestsellers")}
        >
          🏆 Best Sellers ({bestSellers.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "slowmoving" ? " active" : ""}`}
          onClick={() => setActiveTab("slowmoving")}
        >
          🐢 Slow-Moving & Dead Stock ({slowMoving.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "leastordered" ? " active" : ""}`}
          onClick={() => setActiveTab("leastordered")}
        >
          📉 Least Ordered ({leastOrdered.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "funnel" ? " active" : ""}`}
          onClick={() => setActiveTab("funnel")}
        >
          📊 Product Funnel
        </button>
        <button
          className={`sa-date-pill${activeTab === "all" ? " active" : ""}`}
          onClick={() => setActiveTab("all")}
        >
          📦 All Catalog ({allProducts.length})
        </button>
      </div>

      {/* Tab 1: Best Sellers */}
      {activeTab === "bestsellers" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Top Selling Products</div>
            <span className="sa-badge success">Ranked by revenue</span>
          </div>
          <div className="sa-card-body no-pad">
            {bestSellers.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Units Sold</th>
                    <th>Orders</th>
                    <th>Revenue</th>
                    <th>Weekly Velocity</th>
                    <th>In Stock</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bestSellers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          {p.imageUrl ? (
                            <img
                              src={p.imageUrl}
                              alt=""
                              style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }}
                            />
                          ) : (
                            <div style={{ width: 36, height: 36, borderRadius: 6, background: "var(--sa-surface-3)", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              📦
                            </div>
                          )}
                          <div style={{ fontWeight: 600 }}>{p.title}</div>
                        </div>
                      </td>
                      <td>{fmtNum(p.unitsSold)}</td>
                      <td>{fmtNum(p.orders)}</td>
                      <td style={{ fontWeight: 600, color: "var(--sa-emerald)" }}>{fmtMoney(p.revenue)}</td>
                      <td>{p.weeklyVelocity} / wk</td>
                      <td>{fmtNum(p.inventory)}</td>
                      <td>
                        <span className={getStatusBadgeClass(p.velocityStatus)}>{p.velocityStatus}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">📦</div>
                <div className="sa-empty-title">No orders recorded in this timeframe</div>
                <div className="sa-empty-body">
                  Once your store sells items, your top generating products will be ranked here.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Slow-Moving Stock */}
      {activeTab === "slowmoving" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Slow-Moving & Dead Stock Diagnostics</div>
              <div className="sa-text-muted sa-text-small">
                Calculated by sales velocity relative to remaining inventory and days since last sale
              </div>
            </div>
          </div>
          <div className="sa-card-body no-pad">
            {slowMoving.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Classification</th>
                    <th>Inventory Trapped</th>
                    <th>Price</th>
                    <th>Units Sold ({periodDays}d)</th>
                    <th>Daily Velocity</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {slowMoving.map((p) => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.title}</td>
                      <td>
                        <span className={getStatusBadgeClass(p.velocityStatus)}>{p.velocityStatus}</span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{fmtNum(p.inventory)} units</td>
                      <td>{fmtMoney(p.price)}</td>
                      <td>{fmtNum(p.unitsSold)}</td>
                      <td>{p.velocity} / day</td>
                      <td>
                        <a
                          href={shop ? `https://${shop}/admin/products/${p.id.split("/").pop()}` : `https://admin.shopify.com/store`}
                          target="_blank"
                          rel="noreferrer"
                          className="sa-btn sa-btn-ghost"
                          style={{ padding: "4px 8px", fontSize: 11 }}
                        >
                          View in Shopify ↗
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">✨</div>
                <div className="sa-empty-title">No slow-moving or dead stock detected</div>
                <div className="sa-empty-body">All active products with inventory are turning over cleanly.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Least Ordered */}
      {activeTab === "leastordered" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Least Ordered Products</div>
            <span className="sa-badge warning">{periodDays} Day Window</span>
          </div>
          <div className="sa-card-body no-pad">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Orders</th>
                  <th>Units Sold</th>
                  <th>Inventory</th>
                  <th>Price</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {leastOrdered.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.title}</td>
                    <td>{fmtNum(p.orders)}</td>
                    <td>{fmtNum(p.unitsSold)}</td>
                    <td>{fmtNum(p.inventory)}</td>
                    <td>{fmtMoney(p.price)}</td>
                    <td>
                      <span className={getStatusBadgeClass(p.velocityStatus)}>{p.velocityStatus}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 4: Product Funnel */}
      {activeTab === "funnel" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Product Conversion Funnel</div>
              <div className="sa-text-muted sa-text-small">
                Modeled conversion stages: Views → Add to Cart → Checkout → Purchase
              </div>
            </div>
          </div>
          <div className="sa-card-body">
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: "var(--sa-space-4)", marginBottom: "var(--sa-space-6)" }}>
              <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
                <div className="sa-metric-label">1. Product Views</div>
                <div className="sa-metric-value">{fmtNum(allProducts.length * 45)}</div>
                <div className="sa-text-muted sa-text-small">Catalog reach</div>
              </div>
              <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
                <div className="sa-metric-label">2. Add to Cart</div>
                <div className="sa-metric-value">{fmtNum(Math.round(allProducts.length * 45 * 0.12))}</div>
                <div className="sa-text-muted sa-text-small">12.0% cart rate</div>
              </div>
              <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
                <div className="sa-metric-label">3. Checkout Initiated</div>
                <div className="sa-metric-value">{fmtNum(Math.round(allProducts.length * 45 * 0.05))}</div>
                <div className="sa-text-muted sa-text-small">41.6% of carts</div>
              </div>
              <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
                <div className="sa-metric-label">4. Purchases</div>
                <div className="sa-metric-value">{fmtNum(bestSellers.reduce((s, p) => s + p.orders, 0))}</div>
                <div className="sa-text-muted sa-text-small">Completed sales</div>
              </div>
            </div>

            <table className="sa-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Estimated Views</th>
                  <th>Add to Cart</th>
                  <th>Purchases</th>
                  <th>Conversion Rate</th>
                </tr>
              </thead>
              <tbody>
                {allProducts.slice(0, 10).map((p) => {
                  const estViews = Math.max(p.orders * 35, 20);
                  const convRate = estViews > 0 ? ((p.orders / estViews) * 100).toFixed(1) : "0.0";
                  return (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.title}</td>
                      <td>{fmtNum(estViews)}</td>
                      <td>{fmtNum(Math.round(estViews * 0.12))}</td>
                      <td style={{ fontWeight: 600 }}>{fmtNum(p.orders)}</td>
                      <td>
                        <span className={`sa-badge ${parseFloat(convRate) > 3 ? "success" : "neutral"}`}>
                          {convRate}%
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Tab 5: All Catalog */}
      {activeTab === "all" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Complete Catalog Directory</div>
            <span className="sa-badge neutral">{allProducts.length} items</span>
          </div>
          <div className="sa-card-body no-pad">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Price</th>
                  <th>Stock</th>
                  <th>Units Sold</th>
                  <th>Revenue</th>
                  <th>Velocity Status</th>
                </tr>
              </thead>
              <tbody>
                {allProducts.map((p) => (
                  <tr key={p.id}>
                    <td style={{ fontWeight: 600 }}>{p.title}</td>
                    <td>{fmtMoney(p.price)}</td>
                    <td>{fmtNum(p.inventory)}</td>
                    <td>{fmtNum(p.unitsSold)}</td>
                    <td>{fmtMoney(p.revenue)}</td>
                    <td>
                      <span className={getStatusBadgeClass(p.velocityStatus)}>{p.velocityStatus}</span>
                    </td>
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load product intelligence</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing products."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
