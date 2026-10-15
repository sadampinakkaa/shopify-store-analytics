import { useEffect } from "react";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  try {
    await authenticate.admin(request);
  } catch (err) {
    const url = new URL(request.url);
    if (err instanceof Response && !url.searchParams.has("_data")) {
      throw err;
    }
  }
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export const action = async (args) => {
  try {
    const { action: indexAction } = await import("./app._index.jsx");
    if (indexAction) {
      return await indexAction(args);
    }
    return { success: false, error: "No action handler available." };
  } catch (err) {
    console.error("Action error caught in app.jsx:", err);
    return { success: false, error: err.message || "Failed to process request." };
  }
};

function AppBridgeScriptRunner({ html }) {
  useEffect(() => {
    if (!html) return;
    try {
      // 1. If script contains window.open (OAuth redirect), navigate top window directly
      const match = html.match(/window\.open\(([^,]+),\s*([^)]+)\)/);
      if (match) {
        const dest = JSON.parse(match[1]);
        const target = JSON.parse(match[2]);
        if (target === "_top" && window.top) {
          window.top.location.href = dest;
          return;
        } else {
          window.location.href = dest;
          return;
        }
      }

      // 2. Dynamically create script elements so modern browsers execute them
      const temp = document.createElement("div");
      temp.innerHTML = html;
      const scripts = temp.querySelectorAll("script");
      scripts.forEach((s) => {
        const newScript = document.createElement("script");
        Array.from(s.attributes).forEach((attr) => {
          newScript.setAttribute(attr.name, attr.value);
        });
        newScript.textContent = s.textContent;
        document.body.appendChild(newScript);
      });
    } catch (e) {
      console.error("AppBridge script runner error:", e);
    }
  }, [html]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "70vh",
        background: "#faf8f5",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      }}
    >
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e6dfd1",
          borderRadius: "14px",
          padding: "36px 40px",
          textAlign: "center",
          boxShadow: "0 8px 30px rgba(180, 83, 9, 0.08)",
          maxWidth: "460px",
        }}
      >
        <div style={{ fontSize: "40px", marginBottom: "14px" }}>⚡</div>
        <div style={{ fontSize: "18px", fontWeight: "800", color: "#0f172a", marginBottom: "8px" }}>
          Authenticating Store Session
        </div>
        <div style={{ fontSize: "13px", color: "#475569", lineHeight: "1.5" }}>
          Connecting securely to Shopify Admin...
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavMenu>
        <Link to="/app">Dashboard</Link>
        <Link to="/app/sales">Sales</Link>
        <Link to="/app/products">Products</Link>
        <Link to="/app/inventory">Inventory</Link>
        <Link to="/app/performance">Performance</Link>
        <Link to="/app/problems">Problems</Link>
        <Link to="/app/seo">SEO</Link>
        <Link to="/app/conversion">Conversion</Link>
        <Link to="/app/customers">Customers</Link>
        <Link to="/app/geography">Geography</Link>
        <Link to="/app/themes">Theme & Apps</Link>
        <Link to="/app/scan">Scan History</Link>
        <Link to="/app/settings">Plans & Settings</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("App Root ErrorBoundary caught error:", error);

  // If this is a Shopify App Bridge script (OAuth redirect / session approval), execute it immediately!
  if (
    typeof error?.data === "string" &&
    (error.data.includes("<script") || error.data.includes("app-bridge"))
  ) {
    return <AppBridgeScriptRunner html={error.data} />;
  }

  if (
    error &&
    (error.status === 401 ||
      error.status === 302 ||
      error.constructor?.name === "ErrorResponse" ||
      error.constructor?.name === "ErrorResponseImpl")
  ) {
    try {
      const b = boundary.error(error);
      if (b) return b;
    } catch {}
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error?.data === "string"
      ? error.data
      : error?.statusText || "An unexpected error occurred.";

  return (
    <div className="sa-page sa-fade-in">
      <div
        className="sa-card"
        style={{
          maxWidth: 600,
          margin: "40px auto",
          padding: "36px 24px",
          textAlign: "center",
          boxShadow: "var(--sa-shadow)",
        }}
      >
        <div style={{ fontSize: 42, marginBottom: 16 }}>🛡️</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: "var(--sa-text-strong)", marginBottom: 8 }}>
          Application Notice
        </div>
        <div style={{ fontSize: 13, color: "var(--sa-text-muted)", marginBottom: 20, lineHeight: 1.6 }}>
          {errorMessage}
        </div>
        <button
          onClick={() => window.location.reload()}
          className="sa-btn sa-btn-primary"
        >
          🔄 Reload Application
        </button>
      </div>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
