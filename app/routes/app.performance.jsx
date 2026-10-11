import { useState } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getPagePerformanceAudit } from "../services/performance.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const pageType = url.searchParams.get("page") || "home";

  const audit = await getPagePerformanceAudit(session.shop, pageType);
  return audit;
};

export default function PerformancePage() {
  const { activePageType, activePageDef, metrics, pageSummaries, allPageTypes } =
    useLoaderData();
  const revalidator = useRevalidator();

  const handlePageChange = (typeKey) => {
    const url = new URL(window.location.href);
    url.searchParams.set("page", typeKey);
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  const getMetricRating = (type, val) => {
    if (type === "lcp") {
      if (val <= 2.5) return { label: "Good", cls: "sa-badge success" };
      if (val <= 4.0) return { label: "Needs Improvement", cls: "sa-badge warning" };
      return { label: "Poor", cls: "sa-badge critical" };
    }
    if (type === "inp") {
      if (val <= 200) return { label: "Good", cls: "sa-badge success" };
      if (val <= 500) return { label: "Needs Improvement", cls: "sa-badge warning" };
      return { label: "Poor", cls: "sa-badge critical" };
    }
    if (type === "cls") {
      if (val <= 0.1) return { label: "Good", cls: "sa-badge success" };
      if (val <= 0.25) return { label: "Needs Improvement", cls: "sa-badge warning" };
      return { label: "Poor", cls: "sa-badge critical" };
    }
    return { label: "OK", cls: "sa-badge neutral" };
  };

  const lcpRating = getMetricRating("lcp", metrics.lcp);
  const inpRating = getMetricRating("inp", metrics.inp);
  const clsRating = getMetricRating("cls", metrics.cls);

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Performance Analytics</div>
          <div className="sa-page-subtitle">
            Core Web Vitals, speed bottlenecks, and load times measured per page type
          </div>
        </div>
        <div className="sa-inline">
          <span className="sa-badge success">⚡ Real User & Lab Diagnostics</span>
        </div>
      </div>

      {/* Page Type Selector Pills */}
      <div
        style={{
          display: "flex",
          gap: "var(--sa-space-2)",
          marginBottom: "var(--sa-space-6)",
          overflowX: "auto",
          paddingBottom: 4,
        }}
      >
        {allPageTypes.map((pt) => (
          <button
            key={pt.key}
            className={`sa-date-pill${activePageType === pt.key ? " active" : ""}`}
            onClick={() => handlePageChange(pt.key)}
            style={{ whiteSpace: "nowrap" }}
          >
            {pt.label}
          </button>
        ))}
      </div>

      {/* Summary KPI Cards */}
      <div className="sa-metrics-grid">
        <div
          className="sa-metric-card"
          style={{
            "--sa-accent":
              metrics.score >= 80
                ? "var(--sa-emerald)"
                : metrics.score >= 60
                ? "var(--sa-amber)"
                : "var(--sa-rose)",
          }}
        >
          <div className="sa-metric-label">Performance Score</div>
          <div
            className="sa-metric-value"
            style={{
              color:
                metrics.score >= 80
                  ? "var(--sa-emerald)"
                  : metrics.score >= 60
                  ? "var(--sa-amber)"
                  : "var(--sa-rose)",
            }}
          >
            {metrics.score}/100
          </div>
          <div className="sa-text-muted sa-text-small">{activePageDef.label}</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Largest Contentful Paint (LCP)</div>
          <div className="sa-metric-value">{metrics.lcp}s</div>
          <div style={{ marginTop: 4 }}>
            <span className={lcpRating.cls}>{lcpRating.label}</span>
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Interaction to Next Paint (INP)</div>
          <div className="sa-metric-value">{metrics.inp}ms</div>
          <div style={{ marginTop: 4 }}>
            <span className={inpRating.cls}>{inpRating.label}</span>
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
          <div className="sa-metric-label">Cumulative Layout Shift (CLS)</div>
          <div className="sa-metric-value">{metrics.cls}</div>
          <div style={{ marginTop: 4 }}>
            <span className={clsRating.cls}>{clsRating.label}</span>
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Total Load Time</div>
          <div className="sa-metric-value">{metrics.loadTime}s</div>
          <div className="sa-text-muted sa-text-small">{metrics.requestCount} requests</div>
        </div>
      </div>

      {/* Resource Breakdown Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-5)", margin: "var(--sa-space-6) 0" }}>
        {/* Left: Payload Composition */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Asset Weight Breakdown</div>
            <span className="sa-badge neutral">{(metrics.pageSize / 1024).toFixed(2)} MB Total</span>
          </div>
          <div className="sa-card-body">
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--sa-space-4)" }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                  <span>🖼️ Images & Media</span>
                  <span style={{ fontWeight: 600 }}>{metrics.imageSize} KB</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "var(--sa-surface-3)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(metrics.imageSize / metrics.pageSize) * 100}%`, height: "100%", background: "var(--sa-rose)" }} />
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                  <span>📜 JavaScript Execution</span>
                  <span style={{ fontWeight: 600 }}>{metrics.jsSize} KB</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "var(--sa-surface-3)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(metrics.jsSize / metrics.pageSize) * 100}%`, height: "100%", background: "var(--sa-amber)" }} />
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                  <span>🎨 CSS Stylesheets</span>
                  <span style={{ fontWeight: 600 }}>{metrics.cssSize} KB</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "var(--sa-surface-3)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(metrics.cssSize / metrics.pageSize) * 100}%`, height: "100%", background: "var(--sa-cyan)" }} />
                </div>
              </div>

              <div>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 13 }}>
                  <span>🔌 Third-Party App Scripts</span>
                  <span style={{ fontWeight: 600 }}>{metrics.thirdParty} requests</span>
                </div>
                <div style={{ width: "100%", height: 8, background: "var(--sa-surface-3)", borderRadius: 4, overflow: "hidden" }}>
                  <div style={{ width: `${(metrics.thirdParty / metrics.requestCount) * 100}%`, height: "100%", background: "var(--sa-indigo)" }} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Why This Page Is Slow */}
        <div className="sa-card">
          <div className="sa-card-header">
            <div>
              <div className="sa-card-title">Why This Page Is Slow</div>
              <div className="sa-text-muted sa-text-small">
                Root causes impacting Core Web Vitals on {activePageDef.label}
              </div>
            </div>
          </div>
          <div className="sa-card-body no-pad">
            {metrics.bottlenecks.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {metrics.bottlenecks.map((b, i) => (
                  <div
                    key={i}
                    style={{
                      padding: "16px",
                      borderBottom: i < metrics.bottlenecks.length - 1 ? "1px solid var(--sa-border)" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span className={`sa-badge ${b.impact === "HIGH" ? "critical" : "warning"}`}>
                        {b.impact} Impact
                      </span>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{b.title}</span>
                    </div>
                    <div style={{ fontSize: 13, color: "var(--sa-text-muted)", marginTop: 4, lineHeight: 1.5 }}>
                      {b.desc}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6, fontWeight: 500 }}>
                      💡 Fix: {b.solution}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                <div className="sa-empty-icon">⚡</div>
                <div className="sa-empty-title">Fast & Optimized</div>
                <div className="sa-empty-body">
                  No severe render-blocking bottlenecks detected for this page template.
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* All Page Types Comparison Table */}
      <div className="sa-card">
        <div className="sa-card-header">
          <div>
            <div className="sa-card-title">Store-Wide Page Performance Overview</div>
            <div className="sa-text-muted sa-text-small">
              Benchmarking all 10 page types across your storefront
            </div>
          </div>
        </div>
        <div className="sa-card-body no-pad">
          <table className="sa-table">
            <thead>
              <tr>
                <th>Page Type</th>
                <th>Path</th>
                <th>Score</th>
                <th>LCP</th>
                <th>Load Time</th>
                <th>Page Size</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {pageSummaries.map((p) => {
                const isSelected = activePageType === p.key;
                return (
                  <tr
                    key={p.key}
                    style={{
                      background: isSelected ? "rgba(16, 185, 129, 0.05)" : "transparent",
                    }}
                  >
                    <td style={{ fontWeight: 600 }}>{p.label}</td>
                    <td style={{ color: "var(--sa-text-muted)", fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>
                      {p.path}
                    </td>
                    <td>
                      <span
                        className={`sa-badge ${
                          p.score >= 80 ? "success" : p.score >= 60 ? "warning" : "critical"
                        }`}
                      >
                        {p.score}/100
                      </span>
                    </td>
                    <td>{p.lcp}</td>
                    <td>{p.loadTime}</td>
                    <td>{p.pageSize}</td>
                    <td>
                      <button
                        className="sa-btn sa-btn-ghost"
                        onClick={() => handlePageChange(p.key)}
                        style={{ padding: "4px 8px", fontSize: 11 }}
                      >
                        {isSelected ? "Auditing" : "Audit →"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load performance analytics</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing page performance."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
