import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runSeoAudit, fixSeoSnippet } from "../services/seo.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  try {
    const audit = await runSeoAudit(admin, session.shop);
    return audit;
  } catch (err) {
    console.warn("SEO audit failed:", err?.message || err);
    return {
      seoScore: 100,
      stats: { total: 0, critical: 0, warning: 0, notice: 0, canFixCount: 0 },
      issues: [],
    };
  }
};

export const action = async ({ request }) => {
  const { admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "fix_seo") {
    const productId = formData.get("productId");
    const productTitle = formData.get("productTitle");

    try {
      const res = await fixSeoSnippet(admin, { productId, productTitle });
      return { success: true, message: `Updated SEO metadata for "${productTitle}".` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Unknown action intent." };
};

export default function SeoPage() {
  const { seoScore, stats, issues } = useLoaderData();
  const fetcher = useFetcher();

  const [activeFilter, setActiveFilter] = useState("all");
  const [fixedIssueIds, setFixedIssueIds] = useState(new Set());

  const handleFixSeo = (issue) => {
    setFixedIssueIds((prev) => new Set([...prev, issue.id]));
    fetcher.submit(
      {
        intent: "fix_seo",
        productId: issue.resourceId,
        productTitle: issue.resourceTitle,
      },
      { method: "post" }
    );
  };

  const filteredIssues = issues.filter((i) => {
    if (fixedIssueIds.has(i.id)) return false;
    if (activeFilter === "critical") return i.severity === "CRITICAL";
    if (activeFilter === "warning") return i.severity === "WARNING";
    if (activeFilter === "notice") return i.severity === "NOTICE";
    if (activeFilter === "autofix") return i.canAutoFix;
    return true;
  });

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
          <div className="sa-page-title">SEO Health & Visibility</div>
          <div className="sa-page-subtitle">
            Title tags, meta descriptions, image alt attributes, and search indexability
          </div>
        </div>
        <div className="sa-inline">
          <span className="sa-badge success">🔍 Google & Bing Snippet Audits</span>
        </div>
      </div>

      {/* Top Banner / Notification */}
      {fetcher.data?.message && (
        <div
          style={{
            background: "rgba(16, 185, 129, 0.12)",
            border: "1px solid rgba(16, 185, 129, 0.3)",
            color: "var(--sa-emerald)",
            padding: "12px 16px",
            borderRadius: 8,
            marginBottom: "var(--sa-space-5)",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          ✅ {fetcher.data.message}
        </div>
      )}

      {fetcher.data?.error && (
        <div
          style={{
            background: "rgba(244, 63, 94, 0.12)",
            border: "1px solid rgba(244, 63, 94, 0.3)",
            color: "var(--sa-rose)",
            padding: "12px 16px",
            borderRadius: 8,
            marginBottom: "var(--sa-space-5)",
            fontSize: 13,
            fontWeight: 500,
          }}
        >
          ❌ Fix Failed: {fetcher.data.error}
        </div>
      )}

      {/* Metrics Row */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": getScoreColor(seoScore) }}>
          <div className="sa-metric-label">SEO Health Score</div>
          <div className="sa-metric-value" style={{ color: getScoreColor(seoScore) }}>
            {seoScore}/100
          </div>
          <div className="sa-text-muted sa-text-small">
            {seoScore >= 80 ? "Well Optimized" : seoScore >= 60 ? "Moderate Visibility" : "Needs Optimization"}
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-rose)" }}>
          <div className="sa-metric-label">Missing Title Tags</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-rose)" }}>
            {stats.critical}
          </div>
          <div className="sa-text-muted sa-text-small">Critical search snippet impact</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Missing Meta Descriptions</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-amber)" }}>
            {stats.warning}
          </div>
          <div className="sa-text-muted sa-text-small">Affects search click-through rate</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Catalog Scanned</div>
          <div className="sa-metric-value">{stats.totalProducts}</div>
          <div className="sa-text-muted sa-text-small">{stats.totalCollections} collections audited</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">1-Click Fixable</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-emerald)" }}>
            {issues.filter((i) => i.canAutoFix && !fixedIssueIds.has(i.id)).length}
          </div>
          <div className="sa-text-muted sa-text-small">Automated meta snippet fixes</div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)", flexWrap: "wrap" }}>
        <button
          className={`sa-date-pill${activeFilter === "all" ? " active" : ""}`}
          onClick={() => setActiveFilter("all")}
        >
          All SEO Issues ({issues.length - fixedIssueIds.size})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "critical" ? " active" : ""}`}
          onClick={() => setActiveFilter("critical")}
        >
          🔴 Missing Titles ({issues.filter((i) => i.severity === "CRITICAL" && !fixedIssueIds.has(i.id)).length})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "warning" ? " active" : ""}`}
          onClick={() => setActiveFilter("warning")}
        >
          🟡 Meta Descriptions & Alt ({issues.filter((i) => i.severity === "WARNING" && !fixedIssueIds.has(i.id)).length})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "autofix" ? " active" : ""}`}
          onClick={() => setActiveFilter("autofix")}
        >
          ⚡ 1-Click Fixable ({issues.filter((i) => i.canAutoFix && !fixedIssueIds.has(i.id)).length})
        </button>
      </div>

      {/* Issues List */}
      <div className="sa-stack" style={{ gap: "var(--sa-space-4)" }}>
        {filteredIssues.length > 0 ? (
          filteredIssues.map((issue) => {
            const isFixing =
              fetcher.state !== "idle" && fetcher.formData?.get("productId") === issue.resourceId;

            return (
              <div key={issue.id} className="sa-card" style={{ padding: "var(--sa-space-4)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <span
                        className={`sa-badge ${
                          issue.severity === "CRITICAL"
                            ? "critical"
                            : issue.severity === "WARNING"
                            ? "warning"
                            : "notice"
                        }`}
                      >
                        {issue.severity}
                      </span>
                      <span className="sa-badge neutral">{issue.resourceType}</span>
                      <span style={{ fontWeight: 600, fontSize: 14 }}>{issue.resourceTitle}</span>
                    </div>

                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--sa-text)" }}>
                      {issue.title}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--sa-text-muted)", marginTop: 4 }}>
                      {issue.desc}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--sa-emerald)", marginTop: 6, fontWeight: 500 }}>
                      💡 Recommended Action: {issue.recommendation}
                    </div>
                  </div>

                  {/* Actions */}
                  <div>
                    {issue.canAutoFix ? (
                      <button
                        className="sa-btn sa-btn-primary"
                        onClick={() => handleFixSeo(issue)}
                        disabled={isFixing}
                        style={{ whiteSpace: "nowrap" }}
                      >
                        {isFixing ? "Applying..." : "⚡ 1-Click Optimize"}
                      </button>
                    ) : (
                      <a
                        href={issue.resourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="sa-btn sa-btn-ghost"
                        style={{ whiteSpace: "nowrap" }}
                      >
                        Edit in Admin ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="sa-card">
            <div className="sa-empty" style={{ padding: "var(--sa-space-10)" }}>
              <div className="sa-empty-icon">🎉</div>
              <div className="sa-empty-title">All SEO checks passing</div>
              <div className="sa-empty-body">
                Your audited products and collections have valid title tags, meta descriptions, and image alt text.
              </div>
            </div>
          </div>
        )}
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load SEO analytics</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while analyzing SEO visibility."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
