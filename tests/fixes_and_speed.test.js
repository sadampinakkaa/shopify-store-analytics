import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeAppFix, bulkFixAllCritical } from "../app/services/fixes.server.js";
import { getThemeSpeedAudit } from "../app/services/performance.server.js";
import { getShopifyAdminUrl } from "../app/services/auth.server.js";

describe("Universal 1-Click Fix Engine", () => {
  it("executes FIX_OUT_OF_STOCK and drafts product safely", async () => {
    let executedMutation = null;
    let sentVariables = null;

    const mockAdmin = {
      graphql: async (query, opts) => {
        executedMutation = query;
        sentVariables = opts?.variables;
        return {
          json: async () => ({
            data: {
              productUpdate: {
                product: { id: "gid://shopify/Product/123", status: "DRAFT" },
                userErrors: [],
              },
            },
          }),
        };
      },
    };

    const res = await executeAppFix(mockAdmin, "test-store.myshopify.com", {
      problemId: "out-of-stock-123",
      actionKey: "FIX_OUT_OF_STOCK",
      resourceId: "gid://shopify/Product/123",
      resourceTitle: "Summer Dress",
    });

    assert.equal(res.success, true);
    assert.match(res.message, /moved to DRAFT/i);
    assert.equal(sentVariables.product.status, "DRAFT");
  });

  it("executes SET_STATUS to ACTIVE or DRAFT", async () => {
    let sentStatus = null;

    const mockAdmin = {
      graphql: async (query, opts) => {
        sentStatus = opts?.variables?.product?.status;
        return {
          json: async () => ({
            data: {
              productUpdate: {
                product: { id: "gid://shopify/Product/456", status: sentStatus },
                userErrors: [],
              },
            },
          }),
        };
      },
    };

    const res = await executeAppFix(mockAdmin, "test-store.myshopify.com", {
      actionKey: "SET_STATUS",
      resourceId: "456",
      targetStatus: "ACTIVE",
    });

    assert.equal(res.success, true);
    assert.equal(sentStatus, "ACTIVE");
  });

  it("executes FIX_MISSING_DESCRIPTION and generates rich product description", async () => {
    let sentDescription = null;

    const mockAdmin = {
      graphql: async (query, opts) => {
        if (query.includes("getExistingProductDetails")) {
          return {
            json: async () => ({
              data: {
                product: { title: "Silk Scarf", productType: "Accessories", vendor: "Parisian" },
              },
            }),
          };
        }
        sentDescription = opts?.variables?.product?.descriptionHtml;
        return {
          json: async () => ({
            data: {
              productUpdate: {
                product: { id: "gid://shopify/Product/789" },
                userErrors: [],
              },
            },
          }),
        };
      },
    };

    const res = await executeAppFix(mockAdmin, "test-store.myshopify.com", {
      actionKey: "FIX_MISSING_DESCRIPTION",
      resourceId: "789",
      resourceTitle: "Silk Scarf",
    });

    assert.equal(res.success, true);
    assert.match(sentDescription, /Silk Scarf/);
    assert.match(sentDescription, /Product Highlights/);
  });

  it("executes FIX_SEO_METADATA and updates search titles and meta description", async () => {
    let sentSeo = null;

    const mockAdmin = {
      graphql: async (query, opts) => {
        if (query.includes("getExistingProductDetails")) {
          return {
            json: async () => ({
              data: {
                product: { title: "Running Shoes", productType: "Footwear", vendor: "Athletica" },
              },
            }),
          };
        }
        sentSeo = opts?.variables?.product?.seo;
        return {
          json: async () => ({
            data: {
              productUpdate: {
                product: { id: "gid://shopify/Product/888" },
                userErrors: [],
              },
            },
          }),
        };
      },
    };

    const res = await executeAppFix(mockAdmin, "test-store.myshopify.com", {
      actionKey: "FIX_SEO_METADATA",
      resourceId: "888",
      resourceTitle: "Running Shoes",
    });

    assert.equal(res.success, true);
    assert.match(sentSeo.title, /Running Shoes/);
    assert.match(sentSeo.description, /running shoes/i);
  });

  it("executes bulkFixAllCritical safely without throwing errors", async () => {
    const mockAdmin = {
      graphql: async () => ({
        json: async () => ({
          data: {
            products: { edges: [] },
          },
        }),
      }),
    };

    const res = await bulkFixAllCritical(mockAdmin, "test-bulk-store.myshopify.com");
    assert.equal(res.success, true);
    assert.ok(typeof res.message === "string");
    assert.ok(Array.isArray(res.errors));
  });
});

describe("Theme-wise Site Speed Engine", () => {
  it("calculates dual Mobile and Desktop speed scores and Core Web Vitals", async () => {
    const mockAdmin = {
      graphql: async (query) => {
        if (query.includes("getStoreThemesList")) {
          return {
            json: async () => ({
              data: {
                themes: {
                  edges: [
                    {
                      node: {
                        id: "gid://shopify/Theme/99901",
                        name: "Dawn Production",
                        role: "MAIN",
                        createdAt: "2026-01-01",
                        updatedAt: "2026-03-01",
                      },
                    },
                    {
                      node: {
                        id: "gid://shopify/Theme/99902",
                        name: "Dawn Staging",
                        role: "UNPUBLISHED",
                        createdAt: "2026-01-01",
                        updatedAt: "2026-03-01",
                      },
                    },
                  ],
                },
              },
            }),
          };
        }
        if (query.includes("inspectThemeFiles")) {
          return {
            json: async () => ({
              data: {
                theme: {
                  id: "gid://shopify/Theme/99901",
                  name: "Dawn Production",
                  role: "MAIN",
                  files: {
                    edges: [
                      { node: { filename: "assets/global.js", size: 180000, contentType: "application/javascript" } },
                      { node: { filename: "assets/base.css", size: 90000, contentType: "text/css" } },
                      { node: { filename: "assets/hero-banner.jpg", size: 850000, contentType: "image/jpeg" } },
                      { node: { filename: "layout/theme.liquid", size: 35000, contentType: "text/x-liquid" } },
                    ],
                  },
                },
              },
            }),
          };
        }
        return { json: async () => ({ data: {} }) };
      },
    };

    const audit = await getThemeSpeedAudit(mockAdmin, "speed-test-store.myshopify.com", "gid://shopify/Theme/99901");

    assert.equal(audit.themeName, "Dawn Production");
    assert.equal(audit.isLive, true);
    assert.ok(audit.mobile.score >= 50 && audit.mobile.score <= 100);
    assert.ok(audit.desktop.score >= audit.mobile.score);
    assert.ok(parseFloat(audit.mobile.lcp) > 0);
    assert.ok(parseFloat(audit.desktop.lcp) > 0);
    assert.ok(audit.mobile.inp > 0);
    assert.ok(audit.desktop.inp > 0);
    assert.ok(audit.bottlenecks.length > 0);
    assert.ok(audit.bottlenecks.some((b) => b.title.includes("JavaScript") || b.title.includes("Image")));
  });
});

describe("Direct Shopify Admin Navigation & Safe URLs", () => {
  it("formats direct modern admin.shopify.com URLs without 302 redirects", () => {
    const url = getShopifyAdminUrl("my-boutique.myshopify.com", "products", "gid://shopify/Product/12345678");
    assert.equal(url, "https://admin.shopify.com/store/my-boutique/products/12345678");
  });

  it("handles raw numeric IDs and cleans string characters", () => {
    const url = getShopifyAdminUrl("fresh-look.myshopify.com", "products", "987654321");
    assert.equal(url, "https://admin.shopify.com/store/fresh-look/products/987654321");
  });

  it("falls back to resource collection URL when id is absent", () => {
    const url = getShopifyAdminUrl("fresh-look.myshopify.com", "products", "");
    assert.equal(url, "https://admin.shopify.com/store/fresh-look/products");
  });

  it("returns '#' safely if shop is missing", () => {
    const url = getShopifyAdminUrl("", "products", "123");
    assert.equal(url, "#");
  });
});
