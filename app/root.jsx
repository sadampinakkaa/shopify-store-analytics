import { useEffect } from "react";
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from "react-router";

export default function App() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        {/* Shopify CDN — Inter */}
        <link rel="preconnect" href="https://cdn.shopify.com/" />
        <link
          rel="stylesheet"
          href="https://cdn.shopify.com/static/fonts/inter/v4/styles.css"
        />
        {/* JetBrains Mono for code/monospaced values */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap"
        />
        {/* Store Analytics design system */}
        <link rel="stylesheet" href="/store-analytics.css" />
        <Meta />
        <Links />
      </head>
      <body>
        <Outlet />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

function AppBridgeScriptRunner({ html }) {
  useEffect(() => {
    if (!html) return;
    try {
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

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Root ErrorBoundary caught error:", error);

  // If this is a Shopify App Bridge script (OAuth redirect / session approval), execute it immediately!
  if (
    typeof error?.data === "string" &&
    (error.data.includes("<script") || error.data.includes("app-bridge"))
  ) {
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
          <link rel="stylesheet" href="/store-analytics.css" />
        </head>
        <body>
          <AppBridgeScriptRunner html={error.data} />
          <Scripts />
        </body>
      </html>
    );
  }

  const errorMessage =
    error instanceof Error
      ? error.message
      : typeof error?.data === "string"
      ? error.data
      : error?.statusText || "An unexpected error occurred.";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <link rel="stylesheet" href="/store-analytics.css" />
        <Meta />
        <Links />
      </head>
      <body>
        <div className="sa-page sa-fade-in">
          <div
            className="sa-card"
            style={{
              maxWidth: 600,
              margin: "60px auto",
              padding: "40px 24px",
              textAlign: "center",
              boxShadow: "var(--sa-shadow)",
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>🛡️</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: "var(--sa-text-strong)", marginBottom: 8 }}>
              Store Diagnostics Notice
            </div>
            <div style={{ fontSize: 13, color: "var(--sa-text-muted)", marginBottom: 24, lineHeight: 1.6 }}>
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
        <Scripts />
      </body>
    </html>
  );
}
