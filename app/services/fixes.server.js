import prisma from "../db.server.js";

// ─── 1-CLICK REMEDIATION & APP FIX ENGINE ────────────────────────────────────
// Safely executes automated fixes via Shopify Admin GraphQL mutations and
// updates local problem resolution records.

export async function executeAppFix(admin, shop, { problemId, actionKey, resourceId, resourceTitle, quantityDelta, targetStatus }) {
  // If action is to IGNORE or RESOLVE problem directly in database
  if (actionKey === "IGNORE_PROBLEM" && problemId) {
    await prisma.problem.update({
      where: { id: problemId },
      data: { ignoredAt: new Date() },
    });
    return { success: true, message: "Problem dismissed from active queue." };
  }

  if (actionKey === "RESOLVE_PROBLEM" && problemId) {
    await prisma.problem.update({
      where: { id: problemId },
      data: { resolvedAt: new Date() },
    });
    return { success: true, message: "Problem marked as resolved." };
  }

  if (!resourceId) {
    throw new Error("Missing resource ID for fix operation.");
  }

  // Normalize to full Shopify GID if numeric ID was provided
  const formattedResourceId = resourceId.startsWith("gid://")
    ? resourceId
    : `gid://shopify/Product/${resourceId}`;

  // Auto-infer actionKey if missing from database or client payload
  let effectiveActionKey = actionKey;
  if (!effectiveActionKey && problemId) {
    if (problemId.startsWith("out-of-stock-")) effectiveActionKey = "FIX_OUT_OF_STOCK";
    else if (problemId.startsWith("missing-desc-")) effectiveActionKey = "FIX_MISSING_DESCRIPTION";
    else if (problemId.startsWith("missing-seo-")) effectiveActionKey = "FIX_SEO_METADATA";
  }

  if (!effectiveActionKey) {
    throw new Error(`Unsupported or missing fix action key for problem: ${problemId || resourceId}`);
  }

  let result = null;

  // Helper to accurately resolve the product's real title, type, and vendor
  async function resolveProductInfo() {
    let title = resourceTitle;
    let type = "";
    let vendor = "";

    const isBadTitle =
      !title ||
      title === "Product" ||
      title.startsWith("Missing ") ||
      title.includes("Description") ||
      title.includes("SEO") ||
      title.includes("Issue");

    if (isBadTitle && formattedResourceId) {
      try {
        const pRes = await admin.graphql(
          `#graphql
          query getProductDetails($id: ID!) {
            product(id: $id) {
              title
              productType
              vendor
            }
          }`,
          { variables: { id: formattedResourceId } }
        );
        const pJson = await pRes.json();
        const pNode = pJson.data?.product;
        if (pNode?.title) {
          title = pNode.title;
          type = pNode.productType || "";
          vendor = pNode.vendor || "";
        }
      } catch {
        // Fallback
      }
    }
    return { title: title || "Product", type, vendor };
  }

  switch (effectiveActionKey) {
    case "FIX_OUT_OF_STOCK": {
      // Set status to DRAFT to remove out-of-stock item from live storefront
      const res = await admin.graphql(
        `#graphql
        mutation fixProductStatus($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            product: {
              id: formattedResourceId,
              status: "DRAFT",
            },
          },
        }
      );
      const json = await res.json();
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }
      result = { success: true, message: `Product set to DRAFT to protect storefront conversion.` };
      break;
    }

    case "SET_STATUS": {
      const nextStatus = (targetStatus || "ACTIVE").toUpperCase();
      const res = await admin.graphql(
        `#graphql
        mutation updateProductStatus($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              status
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            product: {
              id: formattedResourceId,
              status: nextStatus,
            },
          },
        }
      );
      const json = await res.json();
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }
      result = { success: true, message: `Product status updated to ${nextStatus}.` };
      break;
    }

    case "ADJUST_INVENTORY": {
      const delta = parseInt(quantityDelta || "10", 10);
      if (isNaN(delta) || delta === 0) {
        throw new Error("Invalid inventory adjustment delta.");
      }

      // Query primary location & inventory item ID for the product
      const contextRes = await admin.graphql(
        `#graphql
        query getInventoryContext($id: ID!) {
          locations(first: 1) {
            edges {
              node {
                id
                name
              }
            }
          }
          product(id: $id) {
            id
            title
            variants(first: 5) {
              edges {
                node {
                  id
                  title
                  inventoryItem {
                    id
                  }
                }
              }
            }
          }
        }`,
        { variables: { id: formattedResourceId } }
      );
      const contextJson = await contextRes.json();
      const locationId = contextJson.data?.locations?.edges?.[0]?.node?.id;
      const variantNode = contextJson.data?.product?.variants?.edges?.[0]?.node;
      const inventoryItemId = variantNode?.inventoryItem?.id;

      if (!locationId || !inventoryItemId) {
        throw new Error("Unable to locate inventory item or store location for restocking.");
      }

      const adjustRes = await admin.graphql(
        `#graphql
        mutation adjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup {
              id
              changes {
                name
                delta
                quantityAfterChange
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            input: {
              reason: "restock",
              name: "available",
              changes: [
                {
                  delta,
                  inventoryItemId,
                  locationId,
                },
              ],
            },
          },
        }
      );

      const adjustJson = await adjustRes.json();
      const userErrors = adjustJson.data?.inventoryAdjustQuantities?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }

      result = {
        success: true,
        message: `Restocked ${delta > 0 ? `+${delta}` : delta} units successfully via Shopify Inventory API.`,
      };
      break;
    }

    case "FIX_MISSING_DESCRIPTION": {
      const { title: cleanTitle, vendor: prodVendor } = await resolveProductInfo();
      const vendorCredit = prodVendor ? ` by <em>${prodVendor}</em>` : "";

      const generatedHtml = `<p>Experience premium quality with <strong>${cleanTitle}</strong>${vendorCredit}. Thoughtfully designed for everyday reliability, superior performance, and refined aesthetic appeal.</p>
<h4>Product Highlights</h4>
<ul>
  <li><strong>Premium Craftsmanship:</strong> Built with high-grade, durable materials for lasting reliability.</li>
  <li><strong>Optimized Performance:</strong> Engineered for superior everyday comfort and practical utility.</li>
  <li><strong>Satisfaction Guaranteed:</strong> Thoroughly inspected to ensure high customer satisfaction and dependable use.</li>
</ul>`;

      const res = await admin.graphql(
        `#graphql
        mutation fixProductDesc($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              descriptionHtml
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            product: {
              id: formattedResourceId,
              descriptionHtml: generatedHtml,
            },
          },
        }
      );
      const json = await res.json();
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }
      result = { success: true, message: `Professional product description generated and applied.` };
      break;
    }

    case "FIX_SEO_METADATA": {
      const { title: cleanTitle, vendor: prodVendor } = await resolveProductInfo();
      const seoTitle = `${cleanTitle}${prodVendor ? ` | ${prodVendor}` : ""} – Best Deals & Fast Shipping`.slice(0, 70);
      const seoDesc = `Shop ${cleanTitle} online at the best price. Guaranteed authentic quality, responsive customer service, and fast shipping directly to your door.`.slice(0, 160);

      const res = await admin.graphql(
        `#graphql
        mutation fixProductSeo($product: ProductUpdateInput!) {
          productUpdate(product: $product) {
            product {
              id
              seo {
                title
                description
              }
            }
            userErrors {
              field
              message
            }
          }
        }`,
        {
          variables: {
            product: {
              id: formattedResourceId,
              seo: {
                title: seoTitle,
                description: seoDesc,
              },
            },
          },
        }
      );
      const json = await res.json();
      const userErrors = json.data?.productUpdate?.userErrors ?? [];
      if (userErrors.length > 0) {
        throw new Error(userErrors.map((e) => e.message).join(", "));
      }
      result = { success: true, message: `Search engine title and meta description updated.` };
      break;
    }

    default:
      throw new Error(`Unsupported fix action key: ${actionKey}`);
  }

  // Update Problem record in Prisma database if resolved
  if (problemId) {
    try {
      await prisma.problem.update({
        where: { id: problemId },
        data: {
          resolvedAt: new Date(),
        },
      });
    } catch {
      // Problem might not be stored in db yet
    }
  }

  // Log action into audit trail
  try {
    await prisma.auditLog.create({
      data: {
        shop,
        action: "FIX_APPLIED",
        resource: resourceTitle || resourceId,
        details: `${effectiveActionKey}: ${result?.message || "Remediation applied"}`,
      },
    });
  } catch {
    // Non-blocking
  }

  return result;
}

// ─── BULK FIXES ───────────────────────────────────────────────────────────────

export async function bulkFixAllCritical(admin, shop) {
  const criticalProblems = await prisma.problem.findMany({
    where: {
      shop,
      severity: "CRITICAL",
      fixType: "APP_FIX",
      resolvedAt: null,
    },
    take: 20,
  });

  let fixedCount = 0;
  const errors = [];

  for (const prob of criticalProblems) {
    try {
      await executeAppFix(admin, shop, {
        problemId: prob.id,
        actionKey: prob.actionKey || "FIX_OUT_OF_STOCK",
        resourceId: prob.resourceId,
        resourceTitle: prob.title,
      });
      fixedCount++;
    } catch (err) {
      errors.push(`${prob.title}: ${err.message}`);
    }
  }

  return {
    success: true,
    message: `Resolved ${fixedCount} critical issues automatically.${errors.length > 0 ? ` (${errors.length} skipped)` : ""}`,
    fixedCount,
    errors,
  };
}

export async function bulkFixSeo(admin, shop) {
  const seoProblems = await prisma.problem.findMany({
    where: {
      shop,
      category: "seo",
      fixType: "APP_FIX",
      resolvedAt: null,
    },
    take: 25,
  });

  let fixedCount = 0;
  for (const prob of seoProblems) {
    try {
      await executeAppFix(admin, shop, {
        problemId: prob.id,
        actionKey: "FIX_SEO_METADATA",
        resourceId: prob.resourceId,
        resourceTitle: prob.title,
      });
      fixedCount++;
    } catch {
      // continue
    }
  }

  return {
    success: true,
    message: `Optimized SEO tags for ${fixedCount} products.`,
    fixedCount,
  };
}
