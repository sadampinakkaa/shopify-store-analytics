import { useState } from "react";
import { useLoaderData, useRevalidator, useRouteError } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

// ─── DATE RANGE HELPERS ───────────────────────────────────────────────────────
const DATE_RANGES = [
  { label: "7D",  sinceExpr: "-7d",   untilExpr: "today" },
  { label: "30D", sinceExpr: "-30d",  untilExpr: "today" },
  { label: "90D", sinceExpr: "-90d",  untilExpr: "today" },
  { label: "6M",  sinceExpr: "-180d", untilExpr: "today" },
  { label: "1Y",  sinceExpr: "-365d", untilExpr: "today" },
];

function fmtMoney(val) {
  if (val == null) return "$—";
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: 0,
  }).format(val);
}

function fmtNum(val) {
  if (val == null) return "—";
  return new Intl.NumberFormat("en-US").format(val);
}

function fmtPct(val) {
  if (val == null) return "—";
  return `${(val * 100).toFixed(1)}%`;
}

function extractShopifyQLRows(data, queryKey) {
  try {
    const rows = data?.[queryKey]?.tableData?.rows ?? [];
    const cols = data?.[queryKey]?.tableData?.columns ?? [];
    const colNames = cols.map((c) => c.name);
    return rows.map((row) =>
      Object.fromEntries(row.map((v, i) => [colNames[i], v]))
    );
  } catch {
    return [];
  }
}

function getSinceDate(sinceExpr) {
  const now = new Date();
  const match = String(sinceExpr || "").match(/-(\d+)d/);
  const days = match ? parseInt(match[1], 10) : 30;
  now.setDate(now.getDate() - days);
  return now.toISOString().split("T")[0];
}

// ─── LOADER ───────────────────────────────────────────────────────────────────
export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const since = url.searchParams.get("since") || "-30d";
  const until = url.searchParams.get("until") || "today";

  let kpi = null;
  let trendRows = null;
  let customers = null;

  // ── 1. Try ShopifyQL first (if store has read_reports & Level 2 PCD access) ───
  try {
    const [salesKpiRes, trendRes, customerRes] = await Promise.all([
      admin.graphql(
        `#graphql
        query storeSalesKpi($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData { columns { name dataType } rows }
            parseErrors
          }
        }`,
        {
          variables: {
            query: `FROM sales SHOW gross_sales, net_sales, orders, average_order_value SINCE ${since} UNTIL ${until}`,
          },
        }
      ),
      admin.graphql(
        `#graphql
        query salesTrend($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData { columns { name dataType } rows }
            parseErrors
          }
        }`,
        {
          variables: {
            query: `FROM sales SHOW gross_sales, orders TIMESERIES day SINCE ${since} UNTIL ${until}`,
          },
        }
      ),
      admin.graphql(
        `#graphql
        query customerSegments($query: String!) {
          shopifyqlQuery(query: $query) {
            tableData { columns { name dataType } rows }
            parseErrors
          }
        }`,
        {
          variables: {
            query: `FROM customers SHOW customers GROUP BY customer_type SINCE ${since} UNTIL ${until}`,
          },
        }
      ),
    ]);

    const [salesKpiJson, trendJson, customerJson] = await Promise.all([
      salesKpiRes.json(),
      trendRes.json(),
      customerRes.json(),
    ]);

    const kpiRows = extractShopifyQLRows(salesKpiJson?.data, "shopifyqlQuery");
    if (kpiRows.length > 0) {
      kpi = {
        grossSales: parseFloat(kpiRows[0].gross_sales ?? 0),
        netSales: parseFloat(kpiRows[0].net_sales ?? 0),
        orders: parseInt(kpiRows[0].orders ?? 0, 10),
        aov: parseFloat(kpiRows[0].average_order_value ?? 0),
      };
    }

    const tRows = extractShopifyQLRows(trendJson?.data, "shopifyqlQuery");
    if (tRows.length > 0) {
      trendRows = tRows;
    }

    const custRows = extractShopifyQLRows(customerJson?.data, "shopifyqlQuery");
    if (custRows.length > 0) {
      const newCust = custRows.find((r) => r.customer_type === "new")?.customers ?? 0;
      const retCust = custRows.find((r) => r.customer_type === "returning")?.customers ?? 0;
      customers = { new: Number(newCust), returning: Number(retCust) };
    }
  } catch {
    // Expected on development stores or apps without Level 2 Protected Customer Data approval.
    // Fall back seamlessly to standard Admin GraphQL queries below.
  }

  // ── 2. Fallback to Admin GraphQL Orders if ShopifyQL is unavailable ────────
  if (!kpi) {
    let orderNodes = [];
    const sinceDate = getSinceDate(since);

    try {
      const ordersRes = await admin.graphql(
        `#graphql
        query storeOrdersWithCustomer($query: String!) {
          orders(first: 250, query: $query) {
            edges {
              node {
                id
                createdAt
                totalPriceSet {
                  shopMoney { amount }
                }
                subtotalPriceSet {
                  shopMoney { amount }
                }
                customer {
                  id
                  numberOfOrders
                }
              }
            }
          }
        }`,
        {
          variables: {
            query: `status:any created_at:>=${sinceDate}`,
          },
        }
      );
      const ordersJson = await ordersRes.json();
      orderNodes = ordersJson.data?.orders?.edges?.map((e) => e.node) ?? [];
    } catch {
      // If customer field is restricted, fall back to basic orders query
      try {
        const basicOrdersRes = await admin.graphql(
          `#graphql
          query storeOrdersBasicOnly($query: String!) {
            orders(first: 250, query: $query) {
              edges {
                node {
                  id
                  createdAt
                  totalPriceSet {
                    shopMoney { amount }
                  }
                  subtotalPriceSet {
                    shopMoney { amount }
                  }
                }
              }
            }
          }`,
          {
            variables: {
              query: `status:any created_at:>=${sinceDate}`,
            },
          }
        );
        const basicOrdersJson = await basicOrdersRes.json();
        orderNodes = basicOrdersJson.data?.orders?.edges?.map((e) => e.node) ?? [];
      } catch {
        orderNodes = [];
      }
    }

    let gross = 0;
    let net = 0;
    const dailyMap = {};
    const customerOrderCounts = {};

    for (const ord of orderNodes) {
      const total = parseFloat(ord.totalPriceSet?.shopMoney?.amount || 0);
      const subtotal = parseFloat(ord.subtotalPriceSet?.shopMoney?.amount || 0);
      gross += total;
      net += subtotal;

      const day = ord.createdAt ? ord.createdAt.slice(0, 10) : "";
      if (day) {
        if (!dailyMap[day]) {
          dailyMap[day] = { day, gross_sales: 0, orders: 0 };
        }
        dailyMap[day].gross_sales += total;
        dailyMap[day].orders += 1;
      }

      const custId = ord.customer?.id;
      if (custId) {
        customerOrderCounts[custId] = (customerOrderCounts[custId] || 0) + 1;
      }
    }

    const orderCount = orderNodes.length;
    kpi = {
      grossSales: Math.round(gross * 100) / 100,
      netSales: Math.round(net * 100) / 100,
      orders: orderCount,
      aov: orderCount > 0 ? Math.round((gross / orderCount) * 100) / 100 : 0,
    };

    trendRows = Object.keys(dailyMap)
      .sort()
      .map((day) => ({
        day,
        gross_sales: Math.round(dailyMap[day].gross_sales * 100) / 100,
        orders: dailyMap[day].orders,
      }));

    let newCust = 0;
    let retCust = 0;
    const custValues = Object.values(customerOrderCounts);
    if (custValues.length > 0) {
      for (const count of custValues) {
        if (count > 1) retCust++;
        else newCust++;
      }
    } else {
      newCust = orderCount;
      retCust = 0;
    }
    customers = { new: newCust, returning: retCust };
  }

  // Ensure safe defaults
  if (!kpi) kpi = { grossSales: 0, netSales: 0, orders: 0, aov: 0 };
  if (!trendRows) trendRows = [];
  if (!customers) customers = { new: 0, returning: 0 };

  // ── 3. Admin GraphQL: product & inventory snapshot ─────────────────────────
  let allProducts = [];
  let totalProducts = 0;

  try {
    const productsRes = await admin.graphql(
      `#graphql
      query storeSnapshot {
        products(first: 250, query: "status:active") {
          edges {
            node {
              id
              title
              status
              totalInventory
              hasOnlyDefaultVariant
              media(first: 1) { edges { node { id } } }
              variants(first: 5) {
                edges {
                  node {
                    id
                    price
                    sku
                    barcode
                    inventoryQuantity
                  }
                }
              }
            }
          }
          pageInfo { hasNextPage }
        }
        productsCount { count }
      }`
    );
    const productsJson = await productsRes.json();
    allProducts = productsJson.data?.products?.edges?.map((e) => e.node) ?? [];
    totalProducts = productsJson.data?.productsCount?.count ?? allProducts.length;
  } catch (prodErr) {
    console.warn("Product snapshot query failed:", prodErr.message);
  }

  // ── Parse product diagnostics ──────────────────────────────────────────────
  let criticalCount = 0;
  let warningCount = 0;
  let noticeCount = 0;

  const problems = [];

  for (const p of allProducts) {
    // CRITICAL: out of stock active product
    if ((p.totalInventory ?? 0) <= 0) {
      criticalCount++;
      problems.push({
        id: p.id,
        severity: "CRITICAL",
        title: "Active Product Out of Stock",
        desc: `"${p.title}" has no inventory`,
        fixType: "APP_FIX",
      });
    }

    // CRITICAL: no media
    const hasMedia = (p.media?.edges?.length ?? 0) > 0;
    if (!hasMedia) {
      criticalCount++;
      problems.push({
        id: `${p.id}-media`,
        severity: "CRITICAL",
        title: "Active Product Without Media",
        desc: `"${p.title}" has no images`,
        fixType: "DEV_FIX",
      });
    }

    // CRITICAL: $0 variant
    for (const ve of p.variants?.edges ?? []) {
      const v = ve.node;
      if (parseFloat(v.price ?? "0") === 0) {
        criticalCount++;
        problems.push({
          id: `${v.id}-price`,
          severity: "CRITICAL",
          title: "$0.00 Price on Active Variant",
          desc: `"${p.title}" has a variant priced at $0.00`,
          fixType: "DEV_FIX",
        });
      }

      // WARNING: missing SKU
      if (!v.sku && !v.barcode) {
        warningCount++;
      }
    }
  }

  // Health score: 100 - (CRITICAL×15 + WARNING×5 + NOTICE×2), min 0
  const healthScore = Math.max(0, 100 - (criticalCount * 15 + warningCount * 5 + noticeCount * 2));

  return {
    since,
    until,
    kpi,
    trendRows,
    customers,
    products: { total: totalProducts, active: allProducts.length },
    health: { score: healthScore, critical: criticalCount, warning: warningCount, notice: noticeCount },
    problems: problems.slice(0, 5),
  };
};

// ─── HEALTH RING SVG ──────────────────────────────────────────────────────────
function HealthRing({ score }) {
  const r = 52;
  const circ = 2 * Math.PI * r;
  const progress = ((100 - score) / 100) * circ;
  const color = score >= 80 ? "var(--sa-emerald)" : score >= 50 ? "var(--sa-amber)" : "var(--sa-rose)";

  return (
    <div className="sa-health-ring">
      <svg width="140" height="140" viewBox="0 0 140 140">
        <circle cx="70" cy="70" r={r} fill="none" stroke="var(--sa-surface-3)" strokeWidth="12" />
        <circle
          cx="70" cy="70" r={r}
          fill="none"
          stroke={color}
          strokeWidth="12"
          strokeDasharray={circ}
          strokeDashoffset={progress}
          strokeLinecap="round"
          transform="rotate(-90 70 70)"
          style={{ transition: "stroke-dashoffset 0.8s ease" }}
        />
        <text
          x="70"
          y="68"
          textAnchor="middle"
          dominantBaseline="middle"
          fill={color}
          fontSize="30"
          fontWeight="700"
          fontFamily="Inter, sans-serif"
        >
          {score}
        </text>
        <text
          x="70"
          y="88"
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--sa-text-muted)"
          fontSize="11"
          fontWeight="500"
          fontFamily="Inter, sans-serif"
        >
          /100
        </text>
      </svg>
      <div className="sa-health-score-sub">Store Health Score</div>
    </div>
  );
}

// ─── SPARKLINE SVG ────────────────────────────────────────────────────────────
function Sparkline({ data = [], color = "var(--sa-emerald)" }) {
  if (!data.length) return null;
  const vals = data.map(Number).filter(isFinite);
  if (!vals.length) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 200;
  const h = 40;
  const pts = vals
    .map((v, i) => {
      const x = (i / (vals.length - 1)) * w;
      const y = h - ((v - min) / range) * (h - 4) - 2;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="sa-sparkline">
      <defs>
        <linearGradient id={`grad-${color.replace(/[^a-z]/gi,"")}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polyline
        points={pts}
        fill={`url(#grad-${color.replace(/[^a-z]/gi,"")})`}
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// ─── METRIC CARD ─────────────────────────────────────────────────────────────
function MetricCard({ label, value, delta, accent = "var(--sa-emerald)", sparkData }) {
  const isPositive = delta > 0;
  const isNeutral = delta === 0 || delta == null;

  return (
    <div className="sa-metric-card" style={{ "--sa-accent": accent }}>
      <div className="sa-metric-label">{label}</div>
      <div className="sa-metric-value">{value}</div>
      {!isNeutral && (
        <span className={`sa-metric-delta ${isPositive ? "up" : "down"}`}>
          {isPositive ? "↑" : "↓"} {Math.abs(delta)}%
        </span>
      )}
      {sparkData && <Sparkline data={sparkData} color={accent} />}
    </div>
  );
}

// ─── PROBLEM CARD ─────────────────────────────────────────────────────────────
function ProblemItem({ problem }) {
  const severityClass = problem.severity === "CRITICAL"
    ? "critical" : problem.severity === "WARNING" ? "warning" : "notice";
  const fixClass = problem.fixType === "APP_FIX" ? "app-fix" : "dev-fix";
  const fixLabel = problem.fixType === "APP_FIX" ? "App Fix" : "Dev Fix";

  return (
    <div className="sa-problem-card">
      <div className="sa-problem-card-header">
        <div className="sa-problem-title">{problem.title}</div>
        <div className="sa-problem-badges">
          <span className={`sa-badge ${severityClass}`}>{problem.severity}</span>
          <span className={`sa-badge ${fixClass}`}>{fixLabel}</span>
        </div>
      </div>
      <div className="sa-problem-desc">{problem.desc}</div>
    </div>
  );
}

// ─── PAGE COMPONENT ───────────────────────────────────────────────────────────
export default function OverviewPage() {
  const { kpi, trendRows, customers, products, health, problems, since } = useLoaderData();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();

  const [activePeriod, setActivePeriod] = useState(
    DATE_RANGES.findIndex((r) => r.sinceExpr === since) !== -1
      ? DATE_RANGES.findIndex((r) => r.sinceExpr === since)
      : 1
  );

  const revenueSparkData = trendRows.map((r) => r.gross_sales ?? 0);
  const ordersSparkData  = trendRows.map((r) => r.orders ?? 0);

  const totalCustomers = customers.new + customers.returning;
  const returningRate = totalCustomers > 0
    ? `${((customers.returning / totalCustomers) * 100).toFixed(0)}% returning`
    : null;

  const handlePeriodChange = (idx) => {
    setActivePeriod(idx);
    const { sinceExpr, untilExpr } = DATE_RANGES[idx];
    const url = new URL(window.location.href);
    url.searchParams.set("since", sinceExpr);
    url.searchParams.set("until", untilExpr);
    window.history.pushState({}, "", url);
    revalidator.revalidate();
  };

  return (
    <div className="sa-page sa-fade-in">
      {/* Header */}
      <div className="sa-page-header">
        <div>
          <div className="sa-page-title">Store Dashboard</div>
          <div className="sa-page-subtitle">Store analytics & catalog health overview at a glance</div>
        </div>
        <div className="sa-inline">
          <div className="sa-date-pills">
            {DATE_RANGES.map((r, i) => (
              <button
                key={r.label}
                className={`sa-date-pill${activePeriod === i ? " active" : ""}`}
                onClick={() => handlePeriodChange(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Metrics Row */}
      <div className="sa-metrics-grid">
        <MetricCard
          label="Gross Revenue"
          value={fmtMoney(kpi.grossSales)}
          accent="var(--sa-emerald)"
          sparkData={revenueSparkData}
        />
        <MetricCard
          label="Net Revenue"
          value={fmtMoney(kpi.netSales)}
          accent="var(--sa-cyan)"
          sparkData={revenueSparkData}
        />
        <MetricCard
          label="Orders"
          value={fmtNum(kpi.orders)}
          accent="var(--sa-indigo)"
          sparkData={ordersSparkData}
        />
        <MetricCard
          label="Avg. Order Value"
          value={fmtMoney(kpi.aov)}
          accent="var(--sa-amber)"
        />
        <MetricCard
          label="New Customers"
          value={fmtNum(customers.new)}
          accent="var(--sa-violet)"
        />
        <MetricCard
          label="Returning Customers"
          value={fmtNum(customers.returning)}
          accent="var(--sa-orange)"
        />
      </div>

      {/* Content Grid */}
      <div className="sa-content-grid">

        {/* Left: Revenue Trend */}
        <div className="sa-stack" style={{ gap: "var(--sa-space-5)" }}>
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Revenue Trend</div>
              <span className="sa-badge neutral">{DATE_RANGES[activePeriod]?.label}</span>
            </div>
            <div className="sa-card-body">
              {trendRows.length > 0 ? (
                <div style={{ width: "100%", height: 220 }}>
                  <svg
                    viewBox={`0 0 800 200`}
                    preserveAspectRatio="none"
                    style={{ width: "100%", height: "100%" }}
                  >
                    {(() => {
                      const vals = trendRows.map((r) => parseFloat(r.gross_sales ?? 0));
                      const maxV = Math.max(...vals, 1);
                      const pts = vals.map((v, i) => {
                        const x = (i / Math.max(vals.length - 1, 1)) * 780 + 10;
                        const y = 190 - (v / maxV) * 170;
                        return `${x},${y}`;
                      }).join(" ");

                      const areaBase = `10,190 ${pts} ${((vals.length - 1) / Math.max(vals.length - 1, 1)) * 780 + 10},190`;

                      return (
                        <>
                          <defs>
                            <linearGradient id="revGrad" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#10b981" stopOpacity="0.25" />
                              <stop offset="100%" stopColor="#10b981" stopOpacity="0" />
                            </linearGradient>
                          </defs>
                          <polygon points={areaBase} fill="url(#revGrad)" />
                          <polyline
                            points={pts}
                            fill="none"
                            stroke="#10b981"
                            strokeWidth="2.5"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                          />
                        </>
                      );
                    })()}
                  </svg>
                </div>
              ) : (
                <div className="sa-empty">
                  <div className="sa-empty-icon">📊</div>
                  <div className="sa-empty-title">No sales data yet</div>
                  <div className="sa-empty-body">
                    Once your store has orders, your revenue trend will appear here.
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Products + Customers summary row */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "var(--sa-space-4)" }}>
            <div className="sa-card">
              <div className="sa-card-header">
                <div className="sa-card-title">Products</div>
                <span className="sa-badge success">Active</span>
              </div>
              <div className="sa-card-body">
                <div className="sa-metric-value">{fmtNum(products.total)}</div>
                <div className="sa-text-muted sa-text-small" style={{ marginTop: 6 }}>
                  {fmtNum(products.active)} active scanned
                </div>
              </div>
            </div>

            <div className="sa-card">
              <div className="sa-card-header">
                <div className="sa-card-title">Customers</div>
                {returningRate && <span className="sa-badge neutral">{returningRate}</span>}
              </div>
              <div className="sa-card-body">
                <div className="sa-metric-value">{fmtNum(totalCustomers)}</div>
                <div className="sa-text-muted sa-text-small" style={{ marginTop: 6 }}>
                  {fmtNum(customers.new)} new · {fmtNum(customers.returning)} returning
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right: Health + Problems */}
        <div className="sa-stack" style={{ gap: "var(--sa-space-4)" }}>

          {/* Health Score Ring */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Store Health</div>
              <span className={`sa-badge ${health.score >= 80 ? "success" : health.score >= 50 ? "warning" : "critical"}`}>
                {health.score >= 80 ? "Good" : health.score >= 50 ? "Fair" : "Needs Attention"}
              </span>
            </div>
            <HealthRing score={health.score} />
            <div className="sa-divider" style={{ margin: "0 var(--sa-space-4)" }} />
            <div className="sa-card-body" style={{ paddingTop: "var(--sa-space-3)" }}>
              <div style={{ display: "flex", gap: "var(--sa-space-4)", justifyContent: "center" }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-rose)" }}>{health.critical}</div>
                  <div className="sa-text-muted sa-text-small">Critical</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-amber)" }}>{health.warning}</div>
                  <div className="sa-text-muted sa-text-small">Warnings</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: "var(--sa-violet)" }}>{health.notice}</div>
                  <div className="sa-text-muted sa-text-small">Notices</div>
                </div>
              </div>
            </div>
          </div>

          {/* Top Problems */}
          <div className="sa-card">
            <div className="sa-card-header">
              <div className="sa-card-title">Top Problems</div>
              <a href="/app/problems" className="sa-btn sa-btn-ghost" style={{ padding: "4px 10px", fontSize: 12 }}>
                View all →
              </a>
            </div>
            <div className="sa-card-body no-pad">
              {problems.length > 0 ? (
                problems.map((p) => <ProblemItem key={p.id} problem={p} />)
              ) : (
                <div className="sa-empty" style={{ padding: "var(--sa-space-8)" }}>
                  <div className="sa-empty-icon">✅</div>
                  <div className="sa-empty-title">No critical issues</div>
                  <div className="sa-empty-body">Your store looks healthy! Run a full scan to check for warnings.</div>
                </div>
              )}
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
        <div className="sa-card-title" style={{ fontSize: 18, marginBottom: 8 }}>Unable to load store data</div>
        <div className="sa-text-muted" style={{ marginBottom: 16 }}>
          {error?.message || "An unexpected error occurred while fetching analytics."}
        </div>
        <button className="sa-btn sa-btn-primary" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
