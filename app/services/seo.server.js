// ─── SEO HEALTH SERVICE ──────────────────────────────────────────────────────
// Audits search engine optimization for products, collections, and media assets.

export async function runSeoAudit(admin, shop = "") {
  let products = [];
  let collections = [];

  try {
    const [pRes, cRes] = await Promise.all([
      admin.graphql(
        `#graphql
        query seoAuditProducts {
          products(first: 250, query: "status:active") {
            edges {
              node {
                id
                title
                handle
                descriptionHtml
                seo {
                  title
                  description
                }
                featuredMedia {
                  preview {
                    image {
                      url
                      altText
                    }
                  }
                }
              }
            }
          }
        }`
      ),
      admin.graphql(
        `#graphql
        query seoAuditCollections {
          collections(first: 50) {
            edges {
              node {
                id
                title
                handle
                descriptionHtml
                seo {
                  title
                  description
                }
              }
            }
          }
        }`
      ),
    ]);

    const [pJson, cJson] = await Promise.all([pRes.json(), cRes.json()]);
    products = pJson.data?.products?.edges?.map((e) => e.node) ?? [];
    collections = cJson.data?.collections?.edges?.map((e) => e.node) ?? [];
  } catch (err) {
    console.error("SEO Audit query error:", err.message);
  }

  const issues = [];

  // Product SEO checks
  for (const p of products) {
    const pid = p.id.split("/").pop();
    const adminUrl = shop ? `https://${shop}/admin/products/${pid}` : `/admin/products/${pid}`;
    const seoTitle = p.seo?.title?.trim() || "";
    const seoDesc = p.seo?.description?.trim() || "";
    const altText = p.featuredMedia?.preview?.image?.altText?.trim() || "";
    const hasImage = Boolean(p.featuredMedia?.preview?.image?.url);

    // 1. Missing SEO Title
    if (!seoTitle) {
      issues.push({
        id: `seo-title-${pid}`,
        resourceId: p.id,
        resourceTitle: p.title,
        resourceType: "Product",
        resourceUrl: adminUrl,
        type: "MISSING_TITLE",
        severity: "CRITICAL",
        title: "Missing Custom SEO Title Tag",
        desc: `"${p.title}" relies on the raw product name without keywords or brand identifiers.`,
        recommendation: "Set a structured 50-60 character title (e.g., 'Product Name | Category & Brand').",
        canAutoFix: true,
      });
    }

    // 2. Missing Meta Description
    if (!seoDesc) {
      issues.push({
        id: `seo-desc-${pid}`,
        resourceId: p.id,
        resourceTitle: p.title,
        resourceType: "Product",
        resourceUrl: adminUrl,
        type: "MISSING_DESC",
        severity: "WARNING",
        title: "Missing Search Meta Description",
        desc: `Search engines must guess snippet content for "${p.title}", reducing search CTR.`,
        recommendation: "Provide a compelling 140-160 character description highlighting key benefits.",
        canAutoFix: true,
      });
    }

    // 3. Missing Image Alt Text
    if (hasImage && (!altText || altText.toLowerCase().includes(".jpg") || altText.toLowerCase().includes(".png"))) {
      issues.push({
        id: `seo-alt-${pid}`,
        resourceId: p.id,
        resourceTitle: p.title,
        resourceType: "Product",
        resourceUrl: adminUrl,
        type: "MISSING_ALT",
        severity: "WARNING",
        title: "Missing Image Alt Attribute",
        desc: `Featured media on "${p.title}" lacks descriptive alt text for accessibility & image search.`,
        recommendation: "Add descriptive text including primary product keywords.",
        canAutoFix: false,
      });
    }

    // 4. Overly long SEO Title
    if (seoTitle.length > 70) {
      issues.push({
        id: `seo-long-${pid}`,
        resourceId: p.id,
        resourceTitle: p.title,
        resourceType: "Product",
        resourceUrl: adminUrl,
        type: "LONG_TITLE",
        severity: "NOTICE",
        title: "SEO Title Truncated by Google",
        desc: `Title has ${seoTitle.length} characters (exceeds recommended 60-character limit).`,
        recommendation: "Shorten title to ensure full display on mobile search results.",
        canAutoFix: false,
      });
    }
  }

  // Collection SEO checks
  for (const c of collections) {
    const cid = c.id.split("/").pop();
    const adminUrl = shop ? `https://${shop}/admin/collections/${cid}` : `/admin/collections/${cid}`;
    const seoTitle = c.seo?.title?.trim() || "";
    const seoDesc = c.seo?.description?.trim() || "";

    if (!seoTitle) {
      issues.push({
        id: `seo-col-title-${cid}`,
        resourceId: c.id,
        resourceTitle: c.title,
        resourceType: "Collection",
        resourceUrl: adminUrl,
        type: "MISSING_COL_TITLE",
        severity: "WARNING",
        title: "Missing Collection SEO Title",
        desc: `Collection "${c.title}" has no custom search meta title tag.`,
        recommendation: "Add an optimized category title to target high-intent search queries.",
        canAutoFix: false,
      });
    }

    if (!seoDesc) {
      issues.push({
        id: `seo-col-desc-${cid}`,
        resourceId: c.id,
        resourceTitle: c.title,
        resourceType: "Collection",
        resourceUrl: adminUrl,
        type: "MISSING_COL_DESC",
        severity: "NOTICE",
        title: "Missing Collection Meta Description",
        desc: `Collection "${c.title}" has no meta description snippet configured.`,
        recommendation: "Add category summary copy highlighting best-selling collections.",
        canAutoFix: false,
      });
    }
  }

  const criticalCount = issues.filter((i) => i.severity === "CRITICAL").length;
  const warningCount = issues.filter((i) => i.severity === "WARNING").length;
  const noticeCount = issues.filter((i) => i.severity === "NOTICE").length;

  const seoScore = Math.max(0, 100 - (criticalCount * 12 + warningCount * 4 + noticeCount * 1));

  return {
    seoScore,
    stats: {
      totalProducts: products.length,
      totalCollections: collections.length,
      critical: criticalCount,
      warning: warningCount,
      notice: noticeCount,
      totalIssues: issues.length,
    },
    issues,
  };
}

export async function fixSeoSnippet(admin, { productId, productTitle }) {
  const cleanTitle = productTitle || "Product";
  const seoTitle = `${cleanTitle} | Fast Shipping & Best Deals`.slice(0, 65);
  const seoDesc = `Shop ${cleanTitle} online. Guaranteed high quality craftsmanship, quick delivery, and dedicated customer support.`.slice(0, 155);

  const res = await admin.graphql(
    `#graphql
    mutation fixSeoUpdate($product: ProductUpdateInput!) {
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
          id: productId,
          seo: {
            title: seoTitle,
            description: seoDesc,
          },
        },
      },
    }
  );

  const json = await res.json();
  const errors = json.data?.productUpdate?.userErrors ?? [];
  if (errors.length > 0) {
    throw new Error(errors.map((e) => e.message).join(", "));
  }

  return { success: true, seoTitle, seoDesc };
}
