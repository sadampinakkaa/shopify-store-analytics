import { useState } from "react";
import { useLoaderData, useFetcher, useSearchParams, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  getPeriodDates,
  fetchStoreOrders,
  fetchStoreCatalog,
  computeInventoryIntelligence,
} from "../services/analytics.server";
import { executeAppFix } from "../services/fixes.server";

const PERIODS = [
  { label: "30D", days: 30 },
  { label: "60D", days: 60 },
  { label: "90D", days: 90 },
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

  const inventoryData = computeInventoryIntelligence(products, orders, periodDays);

  return {
    shop: session.shop,
    periodDays,
    ...inventoryData,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "quick_restock") {
    const resourceId = formData.get("resourceId");
    const resourceTitle = formData.get("resourceTitle");
    const delta = formData.get("delta") || "10";

    try {
      const result = await executeAppFix(admin, session.shop, {
        actionKey: "ADJUST_INVENTORY",
        resourceId,
        resourceTitle,
        quantityDelta: delta,
      });
      return {
        success: true,
        message: result?.message || `Added +${delta} units to "${resourceTitle}".`,
        fixedId: resourceId,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to adjust inventory." };
    }
  }

  if (intent === "set_status") {
    const resourceId = formData.get("resourceId");
    const resourceTitle = formData.get("resourceTitle");
    const targetStatus = formData.get("targetStatus") || "DRAFT";

    try {
      const result = await executeAppFix(admin, session.shop, {
        actionKey: "SET_STATUS",
        resourceId,
        resourceTitle,
        targetStatus,
      });
      return {
        success: true,
        message: result?.message || `Set status of "${resourceTitle}" to ${targetStatus}.`,
        fixedId: resourceId,
      };
    } catch (err) {
      return { success: false, error: err.message || "Failed to update product status." };
    }
  }

  return { success: false, error: "Invalid action intent" };
};

export default function InventoryPage() {
  const { shop, periodDays, summary, stockoutRiskItems, deadStockItems, overstockItems } =
    useLoaderData();
  const [searchParams, setSearchParams] = useSearchParams();
  const fetcher = useFetcher();

  const [activeTab, setActiveTab] = useState("stockout"); // 'stockout' | 'deadstock' | 'overstock'

  const handlePeriodChange = (days) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("days", days.toString());
      return next;
    });
  };

  const handleQuickRestock = (item, delta = 10) => {
    fetcher.submit(
      {
        intent: "quick_restock",
        resourceId: item.id,
        resourceTitle: item.title,
        delta: delta.toString(),
      },
      { method: "POST" }
    );
  };

  const handleSetStatus = (item, targetStatus) => {
    fetcher.submit(
      {
        intent: "set_status",
        resourceId: item.id,
        resourceTitle: item.title,
        targetStatus,
      },
      { method: "POST" }
    );
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Inventory Intelligence</div>
          <div className="sa-page-subtitle">
            Stockout risk forecasting, low stock alerts, and trapped capital analysis
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

      {/* Action Notification Toast */}
      {fetcher.data && (
        <div
          className="sa-card"
          style={{
            marginBottom: "var(--sa-space-5)",
            padding: "12px 16px",
            borderColor: fetcher.data.success ? "var(--sa-emerald)" : "var(--sa-rose)",
            background: fetcher.data.success ? "rgba(16,185,129,0.08)" : "rgba(244,63,94,0.08)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span>{fetcher.data.success ? "✅" : "⚠️"}</span>
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              {fetcher.data.message || fetcher.data.error}
            </div>
          </div>
        </div>
      )}

      {/* Summary KPI Cards */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Healthy In-Stock</div>
          <div className="sa-metric-value">{fmtNum(summary.inStockCount)}</div>
          <div className="sa-text-muted sa-text-small">{fmtNum(summary.totalSkus)} total SKUs</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Low Stock (≤ 5 units)</div>
          <div className="sa-metric-value">{fmtNum(summary.lowStockCount)}</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-rose)" }}>
          <div className="sa-metric-label">Out of Stock</div>
          <div className="sa-metric-value">{fmtNum(summary.outOfStockCount)}</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-critical)" }}>
          <div className="sa-metric-label">Stockout Risk SKUs</div>
          <div className="sa-metric-value">{fmtNum(summary.stockoutRiskCount)}</div>
          <div className="sa-text-muted sa-text-small">&lt; 4 weeks supply remaining</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Trapped Dead Stock</div>
          <div className="sa-metric-value">{fmtMoney(summary.deadStockValue)}</div>
          <div className="sa-text-muted sa-text-small">{fmtNum(summary.deadStockCount)} unsold products</div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)" }}>
        <button
          className={`sa-date-pill${activeTab === "stockout" ? " active" : ""}`}
          onClick={() => setActiveTab("stockout")}
        >
          🚨 Stockout Risk Forecast ({stockoutRiskItems.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "deadstock" ? " active" : ""}`}
          onClick={() => setActiveTab("deadstock")}
        >
          💤 Dead Stock & Trapped Capital ({deadStockItems.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "overstock" ? " active" : ""}`}
          onClick={() => setActiveTab("overstock")}
        >
          📦 Overstock Supply ({overstockItems.length})
        </button>
      </div>

      {/* Tab 1: Stockout Risk */}
      {activeTab === "stockout" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Stockout Risk Forecast</div>
              <div className="sa-text-muted sa-text-small">
                Calculated by sales velocity: items running out of inventory within 4 weeks
              </div>
            </div>
            <span className="sa-badge critical">{stockoutRiskItems.length} at risk</span>
          </div>
          <div className="sa-card-body no-pad">
            {stockoutRiskItems.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Current Stock</th>
                    <th>Weekly Sales Rate</th>
                    <th>Estimated Depletion</th>
                    <th>Urgency</th>
                    <th>1-Click Action</th>
                  </tr>
                </thead>
                <tbody>
                  {stockoutRiskItems.map((item) => {
                    const urgencyClass =
                      item.urgency === "EMERGENCY"
                        ? "sa-badge critical"
                        : item.urgency === "HIGH"
                        ? "sa-badge orange"
                        : "sa-badge warning";

                    const isThisRestocking =
                      fetcher.state === "submitting" &&
                      fetcher.formData?.get("resourceId") === item.id;

                    return (
                      <tr key={item.id}>
                        <td style={{ fontWeight: 600 }}>{item.title}</td>
                        <td style={{ fontWeight: 600 }}>{fmtNum(item.inventory)} units</td>
                        <td>{item.weeklyVelocity} / week</td>
                        <td>
                          <div style={{ fontWeight: 600, color: item.weeksToStockout <= 1 ? "var(--sa-rose)" : "inherit" }}>
                            ~{item.weeksToStockout} weeks ({item.daysToStockout} days)
                          </div>
                        </td>
                        <td>
                          <span className={urgencyClass}>{item.urgency}</span>
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <button
                              onClick={() => handleQuickRestock(item, 10)}
                              disabled={fetcher.state === "submitting"}
                              className="sa-btn sa-btn-primary"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                              title="Instantly add +10 inventory units via Shopify API"
                            >
                              {isThisRestocking ? "Restocking..." : "⚡ +10 Restock"}
                            </button>
                            <a
                              href={shop ? `https://${shop}/admin/products/${item.id.split("/").pop()}` : `https://admin.shopify.com/store`}
                              target="_blank"
                              rel="noreferrer"
                              className="sa-btn sa-btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                            >
                              Admin ↗
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">✅</div>
                <div className="sa-empty-title">No imminent stockout risks</div>
                <div className="sa-empty-body">
                  Based on recent sales velocity, all catalog items maintain more than 4 weeks of supply.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Dead Stock */}
      {activeTab === "deadstock" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Dead Stock & Capital Tied Up</div>
              <div className="sa-text-muted sa-text-small">
                Products with positive inventory that have generated 0 sales over the last {periodDays} days
              </div>
            </div>
            <span className="sa-badge warning">{fmtMoney(summary.deadStockValue)} total value</span>
          </div>
          <div className="sa-card-body no-pad">
            {deadStockItems.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Units Trapped</th>
                    <th>Unit Price</th>
                    <th>Total Capital Tied Up</th>
                    <th>1-Click Remediation</th>
                  </tr>
                </thead>
                <tbody>
                  {deadStockItems.map((item) => {
                    const isThisDrafting =
                      fetcher.state === "submitting" &&
                      fetcher.formData?.get("resourceId") === item.id;

                    return (
                      <tr key={item.id}>
                        <td style={{ fontWeight: 600 }}>{item.title}</td>
                        <td>{fmtNum(item.inventory)} units</td>
                        <td>{fmtMoney(item.price)}</td>
                        <td style={{ fontWeight: 600, color: "var(--sa-amber)" }}>
                          {fmtMoney(item.stockValue)}
                        </td>
                        <td>
                          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <button
                              onClick={() => handleSetStatus(item, "DRAFT")}
                              disabled={fetcher.state === "submitting"}
                              className="sa-btn sa-btn-secondary"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                              title="Move product to DRAFT status to clear from active catalog"
                            >
                              {isThisDrafting ? "Drafting..." : "💤 Set to Draft"}
                            </button>
                            <a
                              href={shop ? `https://${shop}/admin/products/${item.id.split("/").pop()}` : `https://admin.shopify.com/store`}
                              target="_blank"
                              rel="noreferrer"
                              className="sa-btn sa-btn-ghost"
                              style={{ padding: "4px 8px", fontSize: 11 }}
                            >
                              Admin ↗
                            </a>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">🎉</div>
                <div className="sa-empty-title">Zero dead stock detected</div>
                <div className="sa-empty-body">Every stocked product in your catalog has recent orders.</div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 3: Overstock */}
      {activeTab === "overstock" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Overstock Inventory</div>
              <div className="sa-text-muted sa-text-small">
                Products with more than 16 weeks (4 months) of supply based on current velocity
              </div>
            </div>
          </div>
          <div className="sa-card-body no-pad">
            {overstockItems.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Inventory</th>
                    <th>Weekly Sales</th>
                    <th>Supply Duration</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {overstockItems.map((item) => (
                    <tr key={item.id}>
                      <td style={{ fontWeight: 600 }}>{item.title}</td>
                      <td>{fmtNum(item.inventory)} units</td>
                      <td>{item.weeklyVelocity} / week</td>
                      <td style={{ fontWeight: 600 }}>~{item.weeksOfSupply} weeks</td>
                      <td>
                        <span className="sa-badge warning">High Holding Cost</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">📦</div>
                <div className="sa-empty-title">No excessive overstock detected</div>
                <div className="sa-empty-body">Your inventory levels align with sales demand.</div>
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load inventory intelligence</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing inventory."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
