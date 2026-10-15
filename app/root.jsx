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

export function ErrorBoundary() {
  const error = useRouteError();
  console.error("Root ErrorBoundary caught error:", error);

  // If this is a Shopify App Bridge script (OAuth redirect / session approval), execute it immediately as HTML!
  if (
    typeof error?.data === "string" &&
    (error.data.includes("<script") || error.data.includes("app-bridge"))
  ) {
    return (
      <html lang="en">
        <head>
          <meta charSet="utf-8" />
          <meta name="viewport" content="width=device-width,initial-scale=1" />
        </head>
        <body>
          <div dangerouslySetInnerHTML={{ __html: error.data }} />
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
