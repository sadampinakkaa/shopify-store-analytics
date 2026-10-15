import { useState } from "react";
import { useLoaderData, useFetcher, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { getActionAdmin } from "../services/auth.server.js";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let sub = await prisma.subscription.findUnique({ where: { shop } });
  if (!sub) {
    sub = await prisma.subscription.create({
      data: {
        shop,
        plan: "Growth",
        status: "active",
        scanLimit: 250,
      },
    });
  }

  const scansThisMonth = await prisma.scan.count({ where: { shop } });

  return {
    shop,
    sub,
    scansThisMonth,
  };
};

export const action = async ({ request }) => {
  const formData = await request.formData();
  const { session, shop } = await getActionAdmin(request, formData);
  const intent = formData.get("intent");

  if (intent === "change_plan") {
    const newPlan = formData.get("plan");
    const limit = newPlan === "Enterprise" ? 1000 : newPlan === "Growth" ? 250 : 50;

    await prisma.subscription.update({
      where: { shop },
      data: { plan: newPlan, scanLimit: limit },
    });

    return { success: true, message: `Switched plan to ${newPlan}.` };
  }

  return { success: false, error: "Unknown intent." };
};

export default function SettingsPage() {
  const { shop, sub, scansThisMonth } = useLoaderData();
  const fetcher = useFetcher();

  const [activePlan, setActivePlan] = useState(sub.plan);
  const [autoScanFreq, setAutoScanFreq] = useState("daily");
  const [protectLiveTheme, setProtectLiveTheme] = useState(true);

  const handleSelectPlan = (plan) => {
    setActivePlan(plan);
    fetcher.submit(
      { intent: "change_plan", plan, shop: shop || "" },
      { method: "post" }
    );
  };

  const plans = [
    {
      name: "Starter",
      price: "$0",
      period: "forever",
      desc: "Essential health checks for small catalogs",
      limit: "50 products scanned",
      features: [
        "Basic catalog health score",
        "Manual defect notifications",
        "Weekly diagnostic reports",
        "Community forum support",
      ],
      badge: "Free",
      color: "var(--sa-cyan)",
    },
    {
      name: "Growth",
      price: "$29",
      period: "per month",
      desc: "Full automated intelligence and 1-click remediation",
      limit: "Up to 500 products",
      features: [
        "⚡ Automated 1-Click App Fixes",
        "Stockout risk & velocity forecaster",
        "Core Web Vitals & page speed audits",
        "SEO title & meta description generator",
        "Safe read-only theme audits",
      ],
      badge: "Most Popular",
      color: "var(--sa-emerald)",
    },
    {
      name: "Enterprise",
      price: "$79",
      period: "per month",
      desc: "High-volume scaling with real-time alerting",
      limit: "Unlimited catalog",
      features: [
        "Everything in Growth",
        "Hourly automated scans",
        "Slack & webhook stockout alerts",
        "Dedicated theme code architecture review",
        "Custom diagnostic rule engine",
      ],
      badge: "High Volume",
      color: "var(--sa-violet)",
    },
  ];

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">SaaS Plans & Store Settings</div>
          <div className="sa-page-subtitle">
            Subscription tiers, diagnostic usage limits, and automated scanning safeguards
          </div>
        </div>
        <div className="sa-inline">
          <span className="sa-badge success">Active Plan: {sub.plan}</span>
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

      {/* Usage Quota Card */}
      <div className="sa-card" style={{ marginBottom: "var(--sa-space-6)" }}>
        <div className="sa-card-header">
          <div className="sa-card-title">Diagnostic Scan Quota</div>
          <span className="sa-badge neutral">
            {scansThisMonth} of {sub.scanLimit} scans used
          </span>
        </div>
        <div className="sa-card-body">
          <div style={{ width: "100%", height: 12, background: "var(--sa-surface-3)", borderRadius: 6, overflow: "hidden", marginBottom: 12 }}>
            <div
              style={{
                width: `${Math.min((scansThisMonth / Math.max(sub.scanLimit, 1)) * 100, 100)}%`,
                height: "100%",
                background: "var(--sa-emerald)",
                borderRadius: 6,
              }}
            />
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--sa-text-muted)" }}>
            <span>Monthly scan cycle resets on the 1st of each month</span>
            <span>{Math.max(sub.scanLimit - scansThisMonth, 0)} scans remaining</span>
          </div>
        </div>
      </div>

      {/* Pricing Plans Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "var(--sa-space-5)", marginBottom: "var(--sa-space-6)" }}>
        {plans.map((p) => {
          const isCurrent = activePlan === p.name;

          return (
            <div
              key={p.name}
              className="sa-card"
              style={{
                border: isCurrent ? `2px solid ${p.color}` : "1px solid var(--sa-border)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                padding: "var(--sa-space-6)",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "var(--sa-text)" }}>{p.name}</div>
                  <span className="sa-badge" style={{ background: "rgba(255,255,255,0.08)", color: p.color }}>
                    {p.badge}
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 8 }}>
                  <span style={{ fontSize: 32, fontWeight: 800, color: "var(--sa-text)" }}>{p.price}</span>
                  <span style={{ fontSize: 12, color: "var(--sa-text-muted)" }}>{p.period}</span>
                </div>

                <div style={{ fontSize: 13, color: "var(--sa-text-muted)", marginBottom: 16 }}>
                  {p.desc}
                </div>

                <div style={{ fontSize: 12, fontWeight: 600, color: p.color, marginBottom: 16 }}>
                  Quota: {p.limit}
                </div>

                <div style={{ borderTop: "1px solid var(--sa-border)", paddingTop: 16 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", color: "var(--sa-text-muted)", marginBottom: 10 }}>
                    Included Features:
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8, fontSize: 13 }}>
                    {p.features.map((feat, i) => (
                      <li key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ color: p.color }}>✓</span> {feat}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div style={{ marginTop: 24 }}>
                <button
                  className={`sa-btn ${isCurrent ? "sa-btn-primary" : "sa-btn-ghost"}`}
                  onClick={() => handleSelectPlan(p.name)}
                  disabled={isCurrent}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {isCurrent ? "Current Plan" : `Upgrade to ${p.name}`}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Safety & Automation Preferences */}
      <div className="sa-card">
        <div className="sa-card-header">
          <div className="sa-card-title">Automation & Safety Guardrails</div>
          <span className="sa-badge success">Merchant Protected</span>
        </div>
        <div className="sa-card-body">
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--sa-space-5)" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Strict Live Theme Protection</div>
                <div style={{ fontSize: 12, color: "var(--sa-text-muted)" }}>
                  Require explicit double-confirmation before modifying live theme templates
                </div>
              </div>
              <input
                type="checkbox"
                checked={protectLiveTheme}
                onChange={(e) => setProtectLiveTheme(e.target.checked)}
                style={{ width: 18, height: 18, cursor: "pointer" }}
              />
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Automated Diagnostic Scan Cadence</div>
                <div style={{ fontSize: 12, color: "var(--sa-text-muted)" }}>
                  Frequency of automated background catalog audits
                </div>
              </div>
              <select
                value={autoScanFreq}
                onChange={(e) => setAutoScanFreq(e.target.value)}
                style={{
                  background: "var(--sa-surface-2)",
                  color: "#ffffff",
                  border: "1px solid var(--sa-border)",
                  borderRadius: 6,
                  padding: "6px 10px",
                  fontSize: 12,
                }}
              >
                <option value="daily">Daily Automatic Scan (Recommended)</option>
                <option value="weekly">Weekly Automatic Scan</option>
                <option value="manual">Manual Execution Only</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Settings ErrorBoundary caught error:", error);

  try {
    const shopifyBoundary = boundary.error(error);
    if (shopifyBoundary) return shopifyBoundary;
  } catch {
    // fallback
  }

  let errorMessage = "An unexpected error occurred while loading settings.";
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load settings</div>
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
