import prisma from "../db.server.js";

// ─── 1-CLICK REMEDIATION & APP FIX ENGINE ────────────────────────────────────
// Safely executes automated fixes via Shopify Admin GraphQL mutations and
// updates local problem resolution records.

export async function executeAppFix(admin, shop, { problemId, actionKey, resourceId, resourceTitle }) {
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

  // Update Problem record in Prisma database
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
        details: `${actionKey}: ${result?.message || "Remediation applied"}`,
      },
    });
  } catch {
    // Non-blocking
  }

  return result;
}
