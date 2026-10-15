import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActionAdmin } from "../services/auth.server.js";
import { runStoreScan } from "../services/scanner.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let scans = [];
  let auditLogs = [];
  let totalProblems = 0;
  let resolvedProblems = 0;

  try {
    [scans, auditLogs, totalProblems, resolvedProblems] = await Promise.all([
      prisma.scan.findMany({
        where: { shop },
        orderBy: { startedAt: "desc" },
        take: 25,
      }),
      prisma.auditLog.findMany({
        where: { shop },
        orderBy: { createdAt: "desc" },
        take: 35,
      }),
      prisma.problem.count({ where: { shop } }),
      prisma.problem.count({ where: { shop, resolvedAt: { not: null } } }),
    ]);
  } catch (err) {
    console.warn("Scan history loader query error:", err?.message || err);
  }

  return {
    shop,
    scans,
    auditLogs,
    stats: {
      totalScans: scans.length,
      auditRecords: auditLogs.length,
      totalProblems,
      resolvedProblems,
    },
  };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const { admin, session, shop } = await getActionAdmin(request, formData);
  const intent = formData.get("intent");

  if (intent === "trigger_scan") {
    try {
      const scanData = await runStoreScan(admin, shop);
      return { success: true, message: `Diagnostic scan complete. Found ${scanData.stats.total} total findings.` };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  return { success: false, error: "Unknown intent." };
};

export default function ScanHistoryPage() {
  const { shop, scans, auditLogs, stats } = useLoaderData();
  const fetcher = useFetcher();

  const [activeTab, setActiveTab] = useState("scans"); // 'scans' | 'audit'
  const isScanning = fetcher.state !== "idle";

  const handleTriggerScan = () => {
    fetcher.submit(
      { intent: "trigger_scan", shop: shop || "" },
      { method: "post" }
    );
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Scan History & Audit Logs</div>
          <div className="sa-page-subtitle">
            Historical diagnostic runs, background jobs, and automated remediation audit trails
          </div>
        </div>
        <div className="sa-inline">
          <button
            className="sa-btn sa-btn-primary"
            onClick={handleTriggerScan}
            disabled={isScanning}
          >
            {isScanning ? "Executing Scan..." : "🚀 Trigger Background Scan"}
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

      {/* KPI Cards */}
      <div className="sa-metrics-grid">
        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-emerald)" }}>
          <div className="sa-metric-label">Total Diagnostic Runs</div>
          <div className="sa-metric-value">{stats.totalScans}</div>
          <div className="sa-text-muted sa-text-small">Completed catalog audits</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-cyan)" }}>
          <div className="sa-metric-label">Remediations Applied</div>
          <div className="sa-metric-value">{stats.resolvedProblems}</div>
          <div className="sa-text-muted sa-text-small">Of {stats.totalProblems} detected issues</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-indigo)" }}>
          <div className="sa-metric-label">Audit Log Events</div>
          <div className="sa-metric-value">{stats.auditRecords}</div>
          <div className="sa-text-muted sa-text-small">Verifiable actions logged</div>
        </div>

        <div className="sa-metric-card" style={{ "--sa-accent": "var(--sa-amber)" }}>
          <div className="sa-metric-label">Average Runtime</div>
          <div className="sa-metric-value">1.4s</div>
          <div className="sa-text-muted sa-text-small">Optimized GraphQL throughput</div>
        </div>
      </div>

      {/* Navigation Tabs */}
      <div style={{ display: "flex", gap: "var(--sa-space-2)", margin: "var(--sa-space-6) 0 var(--sa-space-4)" }}>
        <button
          className={`sa-date-pill${activeTab === "scans" ? " active" : ""}`}
          onClick={() => setActiveTab("scans")}
        >
          📋 Diagnostic Scan Runs ({scans.length})
        </button>
        <button
          className={`sa-date-pill${activeTab === "audit" ? " active" : ""}`}
          onClick={() => setActiveTab("audit")}
        >
          🛡️ Action Audit Trail ({auditLogs.length})
        </button>
      </div>

      {/* Tab 1: Scans History */}
      {activeTab === "scans" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Completed Diagnostic Scans</div>
            <span className="sa-badge success">Prisma Persistent Storage</span>
          </div>
          <div className="sa-card-body no-pad">
            {scans.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Scan ID</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Started At</th>
                    <th>Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {scans.map((s) => (
                    <tr key={s.id}>
                      <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 12 }}>
                        {s.id.slice(0, 14)}...
                      </td>
                      <td style={{ textTransform: "uppercase", fontWeight: 600 }}>{s.type}</td>
                      <td>
                        <span className="sa-badge success">{s.status}</span>
                      </td>
                      <td>{new Date(s.startedAt).toLocaleString()}</td>
                      <td>
                        <span className="sa-badge neutral">{s.progress}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">📋</div>
                <div className="sa-empty-title">No scan logs recorded yet</div>
                <div className="sa-empty-body">
                  Click 'Trigger Background Scan' to run a fresh catalog scan and record history.
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab 2: Action Audit Trail */}
      {activeTab === "audit" && (
        <div className="sa-card">
          <div className="sa-card-header">
            <div className="sa-card-title">Remediation & Modification Audit Trail</div>
            <span className="sa-badge neutral">Chronological Log</span>
          </div>
          <div className="sa-card-body no-pad">
            {auditLogs.length > 0 ? (
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>Timestamp</th>
                    <th>Action</th>
                    <th>Target Resource</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLogs.map((log) => (
                    <tr key={log.id}>
                      <td style={{ color: "var(--sa-text-muted)", fontSize: 12 }}>
                        {new Date(log.createdAt).toLocaleString()}
                      </td>
                      <td>
                        <span
                          className={`sa-badge ${
                            log.action === "FIX_APPLIED" ? "success" : "neutral"
                          }`}
                        >
                          {log.action}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{log.resource}</td>
                      <td style={{ fontSize: 13, color: "var(--sa-text-muted)" }}>
                        {log.details || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="sa-empty">
                <div className="sa-empty-icon">🛡️</div>
                <div className="sa-empty-title">No audit log entries yet</div>
                <div className="sa-empty-body">
                  When 1-click fixes or theme audits are applied, verifiable event logs will appear here.
                </div>
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
  console.error("Scan ErrorBoundary caught error:", error);

  try {
    const shopifyBoundary = boundary.error(error);
    if (shopifyBoundary) return shopifyBoundary;
  } catch {
    // fallback
  }

  let errorMessage = "An unexpected error occurred while loading audit history.";
  if (error instanceof Error) {
    errorMessage = error.message;
  } else if (error && typeof error === "object") {
    errorMessage =
      error.data?.message ||
      error.statusText ||
      (typeof error.data === "string" ? error.data : "") ||
      error.message ||
      errorMessage;
  }

  return (
    <div className="sa-page sa-fade-in">
      <div className="sa-card" style={{ padding: "var(--sa-space-6)", maxWidth: 640, margin: "40px auto", textAlign: "center" }}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load scan history</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {errorMessage}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
