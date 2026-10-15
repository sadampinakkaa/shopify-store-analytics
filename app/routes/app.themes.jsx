import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActionAdmin } from "../services/auth.server.js";
import { getStoreThemes, scanTheme } from "../services/theme.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let themes = [];
  try {
    themes = await getStoreThemes(admin, shop);
  } catch (err) {
    console.warn("Failed to load themes list:", err?.message || err);
  }

  const defaultTheme = themes.find((t) => t.isLive) || themes[0] || null;

  let initialScan = null;
  if (defaultTheme) {
    try {
      initialScan = await scanTheme(admin, shop, defaultTheme.shopifyId);
    } catch (err) {
      console.warn("Initial theme scan failed:", err?.message || err);
    }
  }

  return {
    shop,
    themes,
    defaultThemeId: defaultTheme?.shopifyId || "",
    initialScan,
  };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const { admin, session, shop } = await getActionAdmin(request, formData);
  const themeId = formData.get("themeId");

  if (!themeId) {
    return { success: false, error: "Theme ID must be explicitly specified." };
  }

  try {
    const scanResult = await scanTheme(admin, shop, themeId);
    return { success: true, scanResult };
  } catch (err) {
    return { success: false, error: err.message };
  }
};

export default function ThemesPage() {
  const { shop, themes, defaultThemeId, initialScan } = useLoaderData();
  const fetcher = useFetcher();

  const [selectedThemeId, setSelectedThemeId] = useState(defaultThemeId);
  const [activeCategory, setActiveCategory] = useState("all"); // 'all' | 'liquid' | 'js' | 'css' | 'assets' | 'ghost'

  const currentTheme = themes.find((t) => t.shopifyId === selectedThemeId) || themes[0];
  const isLiveSelected = currentTheme?.isLive || false;

  const scanData = fetcher.data?.scanResult || initialScan;
  const isScanning = fetcher.state !== "idle";

  const handleScanTheme = () => {
    fetcher.submit(
      { themeId: selectedThemeId, shop: shop || "" },
      {
        method: "post",
        action: typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined,
      }
    );
  };

  const getScoreColor = (score) => {
    if (score >= 80) return "var(--sa-emerald)";
    if (score >= 60) return "var(--sa-amber)";
    return "var(--sa-rose)";
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Theme & App Diagnostics</div>
          <div className="sa-page-subtitle">
            Explicit theme selection, read-only Liquid/JS/CSS audits, and ghost script detection
          </div>
        </div>
        <div className="sa-inline">
          <span className="sa-badge success">🛡️ Safe Read-Only Mode</span>
        </div>
      </div>

      {/* Safety Notice Banner */}
      <div
        style={{
          background: isLiveSelected ? "rgba(245, 158, 11, 0.08)" : "var(--sa-surface)",
          border: `1px solid ${isLiveSelected ? "rgba(245, 158, 11, 0.25)" : "var(--sa-border)"}`,
          borderRadius: 10,
          padding: "16px 20px",
          marginBottom: "var(--sa-space-6)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 16,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ fontSize: 24 }}>{isLiveSelected ? "⚠️" : "🛡️"}</div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: isLiveSelected ? "var(--sa-amber)" : "var(--sa-text)" }}>
              {isLiveSelected
                ? "Live Storefront Theme Selected (Dawn — LIVE)"
                : "Safe Staging / Unpublished Theme Selected"}
            </div>
            <div style={{ fontSize: 12, color: "var(--sa-text-muted)", marginTop: 2 }}>
              Scanning operations are strictly read-only. Unintended modifications to active stores are blocked by design.
            </div>
          </div>
        </div>

        {/* Theme Selector Dropdown */}
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <select
            value={selectedThemeId}
            onChange={(e) => setSelectedThemeId(e.target.value)}
            style={{
              background: "var(--sa-surface-2)",
              color: "#ffffff",
              border: "1px solid var(--sa-border)",
              borderRadius: 8,
              padding: "8px 12px",
              fontSize: 13,
              outline: "none",
              cursor: "pointer",
            }}
          >
            {themes.map((t) => (
              <option key={t.shopifyId} value={t.shopifyId}>
                {t.name} — {t.role} {t.isLive ? "(LIVE)" : ""}
              </option>
            ))}
          </select>

          <button
            className="sa-btn sa-btn-primary"
            onClick={handleScanTheme}
            disabled={isScanning}
            style={{ padding: "8px 16px", whiteSpace: "nowrap" }}
          >
            {isScanning ? "Auditing Theme..." : "🔍 Scan Selected Theme"}
          </button>
        </div>
      </div>

      {/* Metrics Row */}
      {scanData && (
        <div className="sa-metrics-grid">
          <div className="sa-metric-card" style={{ "--sa-accent": getScoreColor(scanData.themeScore) }}>
            <div className="sa-metric-label">Theme Health Score</div>
            <div className="sa-metric-value" style={{ color: getScoreColor(scanData.themeScore) }}>
              {scanData.themeScore}/100
            </div>
            <div className="sa-text-muted sa-text-small">
              {scanData.themeScore >= 80 ? "Optimal Structure" : "Optimization Needed"}
            </div>
          </div>

          <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
            <div className="sa-metric-label">Total Files & Payload</div>
            <div className="sa-metric-value">{scanData.totalFiles}</div>
            <div className="sa-text-muted sa-text-small">{scanData.totalSizeMb} MB total assets</div>
          </div>

          <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
            <div className="sa-metric-label">Liquid & CSS Issues</div>
            <div className="sa-metric-value">{scanData.counts.liquid + scanData.counts.css}</div>
            <div className="sa-text-muted sa-text-small">
              {scanData.counts.liquid} Liquid · {scanData.counts.css} CSS
            </div>
          </div>

          <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-rose)" }}>
            <div className="sa-metric-label">JavaScript & Asset Bloat</div>
            <div className="sa-metric-value">{scanData.counts.js + scanData.counts.assets}</div>
            <div className="sa-text-muted sa-text-small">
              {scanData.counts.js} heavy scripts · {scanData.counts.assets} media
            </div>
          </div>

          <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-violet)" }}>
            <div className="sa-metric-label">Ghost Scripts Detected</div>
            <div className="sa-metric-value">{scanData.counts.ghost}</div>
            <div className="sa-text-muted sa-text-small">Lingering tracking tags</div>
          </div>
        </div>
      )}

      {/* Category Tabs */}
      {scanData && (
        <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)", flexWrap: "wrap" }}>
          <button
            className={`sa-date-pill${activeCategory === "all" ? " active" : ""}`}
            onClick={() => setActiveCategory("all")}
          >
            All Findings ({scanData.counts.totalIssues})
          </button>
          <button
            className={`sa-date-pill${activeCategory === "liquid" ? " active" : ""}`}
            onClick={() => setActiveCategory("liquid")}
          >
            Liquid Checks ({scanData.counts.liquid})
          </button>
          <button
            className={`sa-date-pill${activeCategory === "js" ? " active" : ""}`}
            onClick={() => setActiveCategory("js")}
          >
            JavaScript ({scanData.counts.js})
          </button>
          <button
            className={`sa-date-pill${activeCategory === "css" ? " active" : ""}`}
            onClick={() => setActiveCategory("css")}
          >
            CSS Stylesheets ({scanData.counts.css})
          </button>
          <button
            className={`sa-date-pill${activeCategory === "assets" ? " active" : ""}`}
            onClick={() => setActiveCategory("assets")}
          >
            Large Assets ({scanData.counts.assets})
          </button>
          <button
            className={`sa-date-pill${activeCategory === "ghost" ? " active" : ""}`}
            onClick={() => setActiveCategory("ghost")}
          >
            Ghost App Scripts ({scanData.counts.ghost})
          </button>
        </div>
      )}

      {/* Findings Listing */}
      {scanData && (
        <div className="sa-stack" style={{ gap: "var(--sa-space-4)" }}>
          {/* Liquid Issues */}
          {(activeCategory === "all" || activeCategory === "liquid") &&
            scanData.liquidIssues.map((item, idx) => (
              <div key={`liquid-${idx}`} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="sa-badge warning">{item.severity}</span>
                    <span className="sa-badge neutral">Liquid</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{item.file}</span>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: "var(--sa-text)", marginTop: 4 }}>{item.issue}</div>
                <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6 }}>
                  💡 Recommendation: {item.recommendation}
                </div>
              </div>
            ))}

          {/* JavaScript Issues */}
          {(activeCategory === "all" || activeCategory === "js") &&
            scanData.jsIssues.map((item, idx) => (
              <div key={`js-${idx}`} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className={`sa-badge ${item.severity === "CRITICAL" ? "critical" : "warning"}`}>
                      {item.severity}
                    </span>
                    <span className="sa-badge neutral">JavaScript</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{item.file}</span>
                  </div>
                  <span className="sa-badge orange">{item.size}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--sa-text)", marginTop: 4 }}>{item.issue}</div>
                <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6 }}>
                  💡 Recommendation: {item.recommendation}
                </div>
              </div>
            ))}

          {/* CSS Issues */}
          {(activeCategory === "all" || activeCategory === "css") &&
            scanData.cssIssues.map((item, idx) => (
              <div key={`css-${idx}`} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="sa-badge warning">{item.severity}</span>
                    <span className="sa-badge neutral">CSS</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{item.file}</span>
                  </div>
                  <span className="sa-badge neutral">{item.size}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--sa-text)", marginTop: 4 }}>{item.issue}</div>
                <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6 }}>
                  💡 Recommendation: {item.recommendation}
                </div>
              </div>
            ))}

          {/* Asset Issues */}
          {(activeCategory === "all" || activeCategory === "assets") &&
            scanData.assetIssues.map((item, idx) => (
              <div key={`asset-${idx}`} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="sa-badge warning">{item.severity}</span>
                    <span className="sa-badge neutral">Media Asset</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{item.file}</span>
                  </div>
                  <span className="sa-badge critical">{item.size}</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--sa-text)", marginTop: 4 }}>{item.issue}</div>
                <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6 }}>
                  💡 Recommendation: {item.recommendation}
                </div>
              </div>
            ))}

          {/* Ghost App Scripts */}
          {(activeCategory === "all" || activeCategory === "ghost") &&
            scanData.ghostScripts.map((item, idx) => (
              <div key={`ghost-${idx}`} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="sa-badge notice">{item.severity}</span>
                    <span className="sa-badge neutral">App Tags</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{item.file}</span>
                  </div>
                  <span className="sa-badge neutral">{item.count} tags</span>
                </div>
                <div style={{ fontSize: 13, color: "var(--sa-text)", marginTop: 4 }}>{item.issue}</div>
                <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6 }}>
                  💡 Recommendation: {item.recommendation}
                </div>
              </div>
            ))}

          {scanData.counts.totalIssues === 0 && (
            <div className="sa-card">
              <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                <div className="sa-empty-icon">🎉</div>
                <div className="sa-empty-title">Theme passes all diagnostic audits</div>
                <div className="sa-empty-body">
                  No large assets, deprecated Liquid tags, or ghost tracking tags detected.
                </div>
              </div>
            </div>
          )}
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to audit theme</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing the selected theme."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
