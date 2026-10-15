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

  // If this is a Shopify App Bridge script (OAuth redirect / session approval), execute it immediately as HTML!
  if (
    typeof error?.data === "string" &&
    (error.data.includes("<script") || error.data.includes("app-bridge"))
  ) {
    return <div dangerouslySetInnerHTML={{ __html: error.data }} />;
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
