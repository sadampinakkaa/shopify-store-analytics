import { useState, useEffect } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { runStoreScan } from "../services/scanner.server";
import { executeAppFix } from "../services/fixes.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;

  let scanData;
  try {
    scanData = await runStoreScan(admin, shop);
  } catch (err) {
    console.warn("Scan execution caught in loader:", err?.message || err);
    // Fall back to stored problems from database
    let dbProblems = [];
    try {
      dbProblems = await prisma.problem.findMany({
        where: { shop, resolvedAt: null },
        orderBy: { createdAt: "desc" },
      });
    } catch {
      dbProblems = [];
    }

    const crit = dbProblems.filter((p) => p.severity === "CRITICAL").length;
    const warn = dbProblems.filter((p) => p.severity === "WARNING").length;
    const notc = dbProblems.filter((p) => p.severity === "NOTICE").length;
    const score = Math.max(0, 100 - (crit * 15 + warn * 5 + notc * 2));

    scanData = {
      problems: dbProblems,
      healthScore: score,
      stats: { critical: crit, warning: warn, notice: notc, total: dbProblems.length, resolved: 0 },
      totalProductsScanned: dbProblems.length,
    };
  }

  // Also query any resolved problems from database
  let resolvedCount = 0;
  let resolvedProblems = [];
  try {
    resolvedCount = await prisma.problem.count({
      where: {
        shop,
        resolvedAt: { not: null },
      },
    });
    resolvedProblems = await prisma.problem.findMany({
      where: {
        shop,
        resolvedAt: { not: null },
      },
      orderBy: { resolvedAt: "desc" },
      take: 100,
    });
  } catch {
    resolvedCount = 0;
    resolvedProblems = [];
  }

  return {
    shop,
    problems: scanData?.problems ?? [],
    resolvedProblems,
    healthScore: scanData?.healthScore ?? 100,
    stats: {
      critical: scanData?.stats?.critical ?? 0,
      warning: scanData?.stats?.warning ?? 0,
      notice: scanData?.stats?.notice ?? 0,
      total: scanData?.stats?.total ?? 0,
      resolved: resolvedCount,
    },
    totalProductsScanned: scanData?.totalProductsScanned ?? 0,
  };
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "app_fix") {
    const problemId = formData.get("problemId");
    const actionKey = formData.get("actionKey");
    const resourceId = formData.get("resourceId");
    const resourceTitle = formData.get("resourceTitle");

    try {
      const result = await executeAppFix(admin, session.shop, {
        problemId,
        actionKey,
        resourceId,
        resourceTitle,
      });
      return { success: true, message: result?.message || "Fix successfully applied!", fixedId: problemId };
    } catch (err) {
      console.error("executeAppFix failure in action:", err?.message || err);
      return { success: false, error: err.message, failedId: problemId };
    }
  }

  if (intent === "bulk_fix") {
    try {
      const activeFixables = await prisma.problem.findMany({
        where: { shop: session.shop, fixType: "APP_FIX", resolvedAt: null },
      });
      let count = 0;
      for (const prob of activeFixables) {
        try {
          await executeAppFix(admin, session.shop, {
            problemId: prob.id,
            actionKey: prob.actionKey,
            resourceId: prob.resourceId,
            resourceTitle: prob.resourceTitle || prob.title,
          });
          count++;
        } catch (itemErr) {
          console.warn(`Bulk fix item failed for ${prob.id}:`, itemErr.message);
        }
      }
      await runStoreScan(admin, session.shop);
      return { success: true, message: `Successfully resolved ${count} issue(s) in 1-click!` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  if (intent === "run_scan") {
    const scanData = await runStoreScan(admin, session.shop);
    return { success: true, message: "Diagnostic scan completed successfully." };
  }

  return { success: false, error: "Unknown action intent." };
};

export default function ProblemsPage() {
  const { problems, resolvedProblems = [], healthScore, stats, totalProductsScanned } = useLoaderData();
  const fetcher = useFetcher();

  const [activeFilter, setActiveFilter] = useState("all"); // 'all' | 'critical' | 'warning' | 'notice' | 'app_fix' | 'resolved'
  const [fixedProblemIds, setFixedProblemIds] = useState(new Set());

  const isScanning = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "run_scan";
  const isBulkFixing = fetcher.state !== "idle" && fetcher.formData?.get("intent") === "bulk_fix";

  useEffect(() => {
    if (fetcher.data?.success && fetcher.data?.fixedId) {
      setFixedProblemIds((prev) => new Set([...prev, fetcher.data.fixedId]));
    }
    if (fetcher.data?.success && fetcher.formData?.get("intent") === "bulk_fix") {
      setFixedProblemIds(new Set());
    }
  }, [fetcher.data]);

  const handleFix = (problem) => {
    const actionKey = problem.actionKey || (
      problem.id?.startsWith("out-of-stock-") ? "FIX_OUT_OF_STOCK" :
      problem.id?.startsWith("missing-desc-") ? "FIX_MISSING_DESCRIPTION" :
      problem.id?.startsWith("missing-seo-") ? "FIX_SEO_METADATA" : ""
    );

    fetcher.submit(
      {
        intent: "app_fix",
        problemId: problem.id,
        actionKey,
        resourceId: problem.resourceId,
        resourceTitle: problem.resourceTitle,
      },
      { method: "post", action: "/app/problems" }
    );
  };

  const handleRunScan = () => {
    fetcher.submit({ intent: "run_scan" }, { method: "post", action: "/app/problems" });
  };

  const handleBulkFix = () => {
    fetcher.submit({ intent: "bulk_fix" }, { method: "post", action: "/app/problems" });
  };

  const appFixableCount = problems.filter((p) => p.fixType === "APP_FIX" && !fixedProblemIds.has(p.id)).length;

  const filteredProblems = activeFilter === "resolved"
    ? resolvedProblems
    : problems.filter((p) => {
        if (fixedProblemIds.has(p.id)) return false;
        if (activeFilter === "critical") return p.severity === "CRITICAL";
        if (activeFilter === "warning") return p.severity === "WARNING";
        if (activeFilter === "notice") return p.severity === "NOTICE";
        if (activeFilter === "app_fix") return p.fixType === "APP_FIX";
        return true;
      });

  const remainingCritical = problems.filter(
    (p) => p.severity === "CRITICAL" && !fixedProblemIds.has(p.id)
  ).length;
  const remainingWarning = problems.filter(
    (p) => p.severity === "WARNING" && !fixedProblemIds.has(p.id)
  ).length;
  const remainingNotice = problems.filter(
    (p) => p.severity === "NOTICE" && !fixedProblemIds.has(p.id)
  ).length;
  const currentHealthScore = Math.max(
    0,
    100 - (remainingCritical * 15 + remainingWarning * 5 + remainingNotice * 2)
  );

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Store Problems & Diagnostics</div>
          <div className="sa-page-subtitle">
            Catalog health triage, automated severity scoring, and 1-click remediation
          </div>
        </div>
        <div className="sa-inline" style={{ gap: 8 }}>
          {appFixableCount > 0 && (
            <button
              className="sa-btn sa-btn-primary"
              onClick={handleBulkFix}
              disabled={isBulkFixing || isScanning}
              style={{ background: "var(--sa-emerald)", borderColor: "var(--sa-emerald)", color: "#fff" }}
            >
              {isBulkFixing ? "Applying Fixes..." : `⚡ Fix All (${appFixableCount}) Issues`}
            </button>
          )}
          <button
            className="sa-btn sa-btn-ghost"
            onClick={handleRunScan}
            disabled={isScanning || isBulkFixing}
          >
            {isScanning ? "Scanning Catalog..." : "🔄 Run Diagnostic Scan"}
          </button>
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

      {/* Health Score & Stats Grid */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": currentHealthScore >= 80 ? "var(--sa-emerald)" : currentHealthScore >= 50 ? "var(--sa-amber)" : "var(--sa-rose)" }}>
          <div className="sa-metric-label">Store Health Score</div>
          <div className="sa-metric-value" style={{ color: currentHealthScore >= 80 ? "var(--sa-emerald)" : currentHealthScore >= 50 ? "var(--sa-amber)" : "var(--sa-rose)" }}>
            {currentHealthScore}/100
          </div>
          <div className="sa-text-muted sa-text-small">
            {currentHealthScore >= 80 ? "Good" : currentHealthScore >= 50 ? "Fair" : "Needs Immediate Attention"}
          </div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-rose)" }}>
          <div className="sa-metric-label">Critical Issues</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-rose)" }}>
            {remainingCritical}
          </div>
          <div className="sa-text-muted sa-text-small">Direct transaction impact</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Warnings</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-amber)" }}>
            {remainingWarning}
          </div>
          <div className="sa-text-muted sa-text-small">Medium conversion friction</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Notices</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-indigo)" }}>
            {remainingNotice}
          </div>
          <div className="sa-text-muted sa-text-small">Hygiene & optimization</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Resolved Issues</div>
          <div className="sa-metric-value" style={{ color: "var(--sa-emerald)" }}>
            {stats.resolved + fixedProblemIds.size}
          </div>
          <div className="sa-text-muted sa-text-small">Successfully remediated</div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)", flexWrap: "wrap" }}>
        <button
          className={`sa-date-pill${activeFilter === "all" ? " active" : ""}`}
          onClick={() => setActiveFilter("all")}
        >
          All Issues ({problems.length - fixedProblemIds.size})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "critical" ? " active" : ""}`}
          onClick={() => setActiveFilter("critical")}
        >
          🔴 Critical ({remainingCritical})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "warning" ? " active" : ""}`}
          onClick={() => setActiveFilter("warning")}
        >
          🟡 Warnings ({remainingWarning})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "notice" ? " active" : ""}`}
          onClick={() => setActiveFilter("notice")}
        >
          🔵 Notices ({remainingNotice})
        </button>
        <button
          className={`sa-date-pill${activeFilter === "app_fix" ? " active" : ""}`}
          onClick={() => setActiveFilter("app_fix")}
        >
          ⚡ 1-Click App Fixable (
          {problems.filter((p) => p.fixType === "APP_FIX" && !fixedProblemIds.has(p.id)).length}
          )
        </button>
        <button
          className={`sa-date-pill${activeFilter === "resolved" ? " active" : ""}`}
          onClick={() => setActiveFilter("resolved")}
        >
          ✅ Resolved ({stats.resolved})
        </button>
      </div>

      {/* Problems List */}
      <div className="sa-stack" style={{ gap: "var(--sa-space-4)" }}>
        {filteredProblems.length > 0 ? (
          filteredProblems.map((prob) => {
            const isFixing =
              fetcher.state !== "idle" &&
              fetcher.formData?.get("problemId") === prob.id;

            return (
              <div key={prob.id} className="sa-card" style={{ padding: "var(--sa-space-5)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      {prob.resolvedAt ? (
                        <span className="sa-badge success">✅ RESOLVED</span>
                      ) : (
                        <span
                          className={`sa-badge ${
                            prob.severity === "CRITICAL"
                              ? "critical"
                              : prob.severity === "WARNING"
                              ? "warning"
                              : "notice"
                          }`}
                        >
                          {prob.severity}
                        </span>
                      )}
                      <span
                        className={`sa-badge ${
                          prob.resolvedAt ? "neutral" : prob.fixType === "APP_FIX" ? "success" : "neutral"
                        }`}
                      >
                        {prob.resolvedAt ? "Remediated" : prob.fixType === "APP_FIX" ? "⚡ App Fix" : "🛠️ Dev Fix"}
                      </span>
                      <span className="sa-badge neutral" style={{ textTransform: "capitalize" }}>
                        {prob.category}
                      </span>
                    </div>

                    <div style={{ fontSize: 16, fontWeight: 700, color: "var(--sa-text)" }}>
                      {prob.title}
                    </div>
                  </div>

                  {/* Actions */}
                  <div style={{ textAlign: "right", minWidth: 160 }}>
                    {prob.resolvedAt ? (
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
                        <span className="sa-badge success">Remediated</span>
                        <a
                          href={prob.resourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="sa-btn sa-btn-ghost"
                          style={{ whiteSpace: "nowrap", fontSize: 12 }}
                        >
                          View in Shopify Admin ↗
                        </a>
                      </div>
                    ) : prob.fixType === "APP_FIX" ? (
                      <>
                        <button
                          className="sa-btn sa-btn-primary"
                          onClick={() => handleFix(prob)}
                          disabled={isFixing}
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {isFixing ? "Applying Fix..." : "⚡ 1-Click Fix"}
                        </button>
                        <div style={{ fontSize: 11, color: "var(--sa-text-muted)", marginTop: 4 }}>
                          {prob.actionKey === "FIX_OUT_OF_STOCK" || prob.id?.startsWith("out-of-stock-")
                            ? "Sets status to Draft"
                            : prob.actionKey === "FIX_MISSING_DESCRIPTION" || prob.id?.startsWith("missing-desc-")
                            ? "Generates description"
                            : "Generates SEO tags"}
                        </div>
                      </>
                    ) : (
                      <a
                        href={prob.resourceUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="sa-btn sa-btn-ghost"
                        style={{ whiteSpace: "nowrap" }}
                      >
                        Open in Shopify Admin ↗
                      </a>
                    )}
                  </div>
                </div>

                {/* Problem Description & Impact */}
                <div style={{ margin: "var(--sa-space-3) 0", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-4)", background: "var(--sa-surface-2)", padding: "12px 16px", borderRadius: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--sa-text-muted)", marginBottom: 4 }}>
                      What was wrong
                    </div>
                    <div style={{ fontSize: 13, color: "var(--sa-text)", lineHeight: 1.5 }}>
                      {prob.description}
                    </div>
                  </div>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--sa-text-muted)", marginBottom: 4 }}>
                      {prob.resolvedAt ? "Remediation status" : "Why it matters"}
                    </div>
                    <div style={{ fontSize: 13, color: "var(--sa-text-muted)", lineHeight: 1.5 }}>
                      {prob.resolvedAt
                        ? `Remediated on ${new Date(prob.resolvedAt).toLocaleDateString()} at ${new Date(prob.resolvedAt).toLocaleTimeString()}`
                        : prob.whyItMatters}
                    </div>
                  </div>
                </div>

                {/* Affected Resource */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 8 }}>
                  {prob.resourceImage ? (
                    <img
                      src={prob.resourceImage}
                      alt=""
                      style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }}
                    />
                  ) : (
                    <div style={{ width: 32, height: 32, borderRadius: 6, background: "var(--sa-surface-3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>
                      📦
                    </div>
                  )}
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{prob.resourceTitle}</div>
                    <div style={{ fontSize: 11, color: "var(--sa-text-dimmed)" }}>
                      Resource: {prob.resourceId}
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="sa-card">
            <div className="sa-empty" style={{ padding: "var(--sa-space-10)" }}>
              <div className="sa-empty-icon">🎉</div>
              <div className="sa-empty-title">
                {activeFilter === "resolved" ? "No resolved issues recorded yet" : "All store issues resolved!"}
              </div>
              <div className="sa-empty-body">
                {activeFilter !== "resolved" && stats.resolved > 0 ? (
                  <>
                    Great job! All {stats.resolved} catalog defects have been successfully remediated on Shopify. Click the{" "}
                    <button
                      className="sa-btn sa-btn-ghost"
                      style={{ padding: "2px 8px", display: "inline-flex", fontSize: 12, verticalAlign: "baseline", color: "var(--sa-emerald)", borderColor: "var(--sa-emerald)" }}
                      onClick={() => setActiveFilter("resolved")}
                    >
                      ✅ Resolved ({stats.resolved})
                    </button>{" "}
                    tab above to review all remediated problems.
                  </>
                ) : (
                  `Scanned ${totalProductsScanned} active products and found no active issues matching this filter.`
                )}
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load store diagnostics</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while running store diagnostics."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
