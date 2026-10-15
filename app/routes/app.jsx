import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export const action = async (args) => {
  // If any form or fetcher submits to /app, safely delegate to index action
  const { action: indexAction } = await import("./app._index.jsx");
  if (indexAction) {
    return indexAction(args);
  }
  return { success: false, error: "No action handler available." };
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
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
