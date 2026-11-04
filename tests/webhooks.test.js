import test from "node:test";
import assert from "node:assert/strict";

test("Shopify Mandatory Compliance Webhook Routes Validation", async (t) => {
  const serverBuild = await import("../build/server/index.js");

  await t.test("customers/data_request route exists and rejects invalid HMAC with 401", async () => {
    const route = serverBuild.routes["routes/webhooks.customers.data_request"];
    assert.ok(route, "routes/webhooks.customers.data_request route must exist in server build");
    const action = route.module?.action || route.action;
    assert.ok(action, "action function must be defined");

    const fakeRequest = new Request("https://analytics.pinakkaa.com/webhooks/customers/data_request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "customers/data_request",
        "X-Shopify-Hmac-Sha256": "invalid_test_hmac",
        "X-Shopify-Shop-Domain": "test-store.myshopify.com",
      },
      body: JSON.stringify({
        shop_id: 12345,
        shop_domain: "test-store.myshopify.com",
        customer: { id: 999, email: "shopper@example.com" },
      }),
    });

    const response = await action({ request: fakeRequest });
    assert.equal(response.status, 401, "Invalid HMAC must respond with 401 Unauthorized");
  });

  await t.test("customers/redact route exists and rejects invalid HMAC with 401", async () => {
    const route = serverBuild.routes["routes/webhooks.customers.redact"];
    assert.ok(route, "routes/webhooks.customers.redact route must exist in server build");
    const action = route.module?.action || route.action;
    assert.ok(action, "action function must be defined");

    const fakeRequest = new Request("https://analytics.pinakkaa.com/webhooks/customers/redact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "customers/redact",
        "X-Shopify-Hmac-Sha256": "invalid_test_hmac",
        "X-Shopify-Shop-Domain": "test-store.myshopify.com",
      },
      body: JSON.stringify({
        shop_id: 12345,
        shop_domain: "test-store.myshopify.com",
        customer: { id: 999, email: "shopper@example.com" },
      }),
    });

    const response = await action({ request: fakeRequest });
    assert.equal(response.status, 401, "Invalid HMAC must respond with 401 Unauthorized");
  });

  await t.test("shop/redact route exists and rejects invalid HMAC with 401", async () => {
    const route = serverBuild.routes["routes/webhooks.shop.redact"];
    assert.ok(route, "routes/webhooks.shop.redact route must exist in server build");
    const action = route.module?.action || route.action;
    assert.ok(action, "action function must be defined");

    const fakeRequest = new Request("https://analytics.pinakkaa.com/webhooks/shop/redact", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "shop/redact",
        "X-Shopify-Hmac-Sha256": "invalid_test_hmac",
        "X-Shopify-Shop-Domain": "test-store.myshopify.com",
      },
      body: JSON.stringify({
        shop_id: 12345,
        shop_domain: "test-store.myshopify.com",
      }),
    });

    const response = await action({ request: fakeRequest });
    assert.equal(response.status, 401, "Invalid HMAC must respond with 401 Unauthorized");
  });

  await t.test("compliance route exists and rejects invalid HMAC with 401", async () => {
    const route = serverBuild.routes["routes/webhooks.compliance"];
    assert.ok(route, "routes/webhooks.compliance route must exist in server build");
    const action = route.module?.action || route.action;
    assert.ok(action, "action function must be defined");

    const fakeRequest = new Request("https://analytics.pinakkaa.com/webhooks/compliance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Topic": "shop/redact",
        "X-Shopify-Hmac-Sha256": "invalid_test_hmac",
        "X-Shopify-Shop-Domain": "test-store.myshopify.com",
      },
      body: JSON.stringify({
        shop_id: 12345,
        shop_domain: "test-store.myshopify.com",
      }),
    });

    const response = await action({ request: fakeRequest });
    assert.equal(response.status, 401, "Invalid HMAC must respond with 401 Unauthorized");
  });
});
