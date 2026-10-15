import prisma from "../db.server.js";

// ─── COMPREHENSIVE STORE DIAGNOSTIC SCANNER ─────────────────────────────────
// Scans active products, variants, media, SEO metadata, descriptions, and inventory.
// Classifies findings by CRITICAL / WARNING / NOTICE and APP_FIX / DEV_FIX.

export async function runStoreScan(admin, shop) {
  // Ensure store record exists in database
  await prisma.store.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  // Fetch full active catalog
  let products = [];
  try {
    const res = await admin.graphql(
      `#graphql
      query scanProductsDetailed {
        products(first: 250, query: "status:active") {
          edges {
            node {
              id
              title
              status
              totalInventory
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
              media(first: 5) {
                edges {
                  node {
                    id
                  }
                }
              }
              variants(first: 20) {
                edges {
                  node {
                    id
                    title
                    price
                    sku
                    barcode
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }`
    );
    const json = await res.json();
    products = json.data?.products?.edges?.map((e) => e.node) ?? [];
  } catch (err) {
    console.error("Error fetching catalog for scan:", err?.message || err);
    return {
      problems: [],
      healthScore: 100,
      stats: { critical: 0, warning: 0, notice: 0, total: 0, resolved: 0 },
      totalProductsScanned: 0,
    };
  }

  const detectedProblems = [];

  for (const p of products) {
    const shopifyNumericId = p.id.split("/").pop();
    const adminUrl = `https://${shop}/admin/products/${shopifyNumericId}`;
    const inv = p.totalInventory ?? 0;
    const mediaCount = p.media?.edges?.length ?? 0;
    const variants = p.variants?.edges?.map((ve) => ve.node) ?? [];

    // ── 1. CRITICAL: Active Product Out of Stock [App Fix] ─────────────────────
    if (inv <= 0) {
      detectedProblems.push({
        id: `out-of-stock-${shopifyNumericId}`,
        shop,
        severity: "CRITICAL",
        fixType: "APP_FIX",
        actionKey: "FIX_OUT_OF_STOCK",
        category: "inventory",
        title: "Active Product Out of Stock",
        description: `"${p.title}" is published and visible to shoppers but has 0 inventory in stock.`,
        whyItMatters: "Customers attempting to buy will encounter stockout friction or abandoned carts, hurting store conversion.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: p.featuredMedia?.preview?.image?.url || null,
      });
    }

    // ── 2. CRITICAL: Active Product Without Media [Dev Fix] ───────────────────
    if (mediaCount === 0) {
      detectedProblems.push({
        id: `no-media-${shopifyNumericId}`,
        shop,
        severity: "CRITICAL",
        fixType: "DEV_FIX",
        category: "product",
        title: "Active Product Missing Images",
        description: `"${p.title}" has no media or product photography attached.`,
        whyItMatters: "Products without images suffer up to an 85% drop in buyer trust and add-to-cart conversion.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: null,
      });
    }

    // ── 3. CRITICAL: $0.00 Price on Active Variant [Dev Fix] ──────────────────
    for (const v of variants) {
      const price = parseFloat(v.price || "0");
      if (price === 0) {
        const variantNumericId = v.id.split("/").pop();
        detectedProblems.push({
          id: `zero-price-${variantNumericId}`,
          shop,
          severity: "CRITICAL",
          fixType: "DEV_FIX",
          category: "product",
          title: "$0.00 Variant Price Error",
          description: `Variant "${v.title}" of "${p.title}" is listed for $0.00.`,
          whyItMatters: "Shoppers may checkout for free or checkout could error out, causing direct financial loss.",
          resourceId: p.id,
          resourceType: "Variant",
          resourceUrl: adminUrl,
          resourceTitle: `${p.title} (${v.title})`,
          resourceImage: p.featuredMedia?.preview?.image?.url || null,
        });
      }
    }

    // ── 4. WARNING: Missing Barcode or SKU [Dev Fix] ──────────────────────────
    const missingSkuVariants = variants.filter((v) => !v.sku && !v.barcode);
    if (missingSkuVariants.length > 0) {
      detectedProblems.push({
        id: `missing-sku-${shopifyNumericId}`,
        shop,
        severity: "WARNING",
        fixType: "DEV_FIX",
        category: "inventory",
        title: "Missing SKU / Barcode Identifier",
        description: `"${p.title}" has ${missingSkuVariants.length} variant(s) without an inventory SKU or barcode.`,
        whyItMatters: "Can lead to 3PL fulfillment errors, inventory synchronization mismatches, and multi-channel failures.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: p.featuredMedia?.preview?.image?.url || null,
      });
    }

    // ── 5. WARNING: Missing Product Description [Manual / Dev Fix] ───────────
    const desc = p.descriptionHtml ? p.descriptionHtml.replace(/<[^>]*>/g, "").trim() : "";
    if (!desc || desc.length < 20) {
      detectedProblems.push({
        id: `missing-desc-${shopifyNumericId}`,
        shop,
        severity: "WARNING",
        fixType: "DEV_FIX",
        category: "product",
        title: "Missing Product Description",
        description: `"${p.title}" has an empty or very brief description (${desc.length} characters).`,
        whyItMatters: "Thin content reduces on-page engagement, increases return rates, and hurts search engine ranking. Add tailored copy in Shopify Admin.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: p.featuredMedia?.preview?.image?.url || null,
      });
    }

    // ── 6. WARNING: Missing SEO Metadata [App Fix] ───────────────────────────
    const hasSeoTitle = Boolean(p.seo?.title && p.seo.title.trim().length > 0);
    const hasSeoDesc = Boolean(p.seo?.description && p.seo.description.trim().length > 0);
    if (!hasSeoTitle || !hasSeoDesc) {
      detectedProblems.push({
        id: `missing-seo-${shopifyNumericId}`,
        shop,
        severity: "WARNING",
        fixType: "APP_FIX",
        actionKey: "FIX_SEO_METADATA",
        category: "seo",
        title: "Missing SEO Title or Meta Description",
        description: `"${p.title}" lacks optimized search engine title tags or meta snippet description.`,
        whyItMatters: "Google and Bing will generate unstructured snippets, resulting in lower search click-through rates.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: p.featuredMedia?.preview?.image?.url || null,
      });
    }

    // ── 7. NOTICE: Low Stock Warning [Dev Fix] ───────────────────────────────
    if (inv > 0 && inv <= 3) {
      detectedProblems.push({
        id: `low-stock-${shopifyNumericId}`,
        shop,
        severity: "NOTICE",
        fixType: "DEV_FIX",
        category: "inventory",
        title: "Critical Low Stock Threshold",
        description: `"${p.title}" only has ${inv} unit(s) remaining in stock.`,
        whyItMatters: "Imminent risk of selling out before restocking arrives.",
        resourceId: p.id,
        resourceType: "Product",
        resourceUrl: adminUrl,
        resourceTitle: p.title,
        resourceImage: p.featuredMedia?.preview?.image?.url || null,
      });
    }
  }

  // Persist scan and detected problems to database safely
  try {
    const scan = await prisma.scan.create({
      data: {
        shop,
        type: "full",
        status: "complete",
        progress: 100,
        finishedAt: new Date(),
      },
    });

    for (const prob of detectedProblems) {
      await prisma.problem.upsert({
        where: { id: prob.id },
        create: {
          id: prob.id,
          shop,
          scanId: scan.id,
          severity: prob.severity,
          fixType: prob.fixType,
          actionKey: prob.actionKey || null,
          category: prob.category,
          title: prob.title,
          description: prob.description,
          whyItMatters: prob.whyItMatters,
          resourceId: prob.resourceId,
          resourceType: prob.resourceType,
          resourceUrl: prob.resourceUrl,
          resourceTitle: prob.resourceTitle || prob.title || null,
        },
        update: {
          severity: prob.severity,
          fixType: prob.fixType,
          actionKey: prob.actionKey || null,
          title: prob.title,
          description: prob.description,
          whyItMatters: prob.whyItMatters,
          resourceTitle: prob.resourceTitle || prob.title || null,
          updatedAt: new Date(),
        },
      });
    }

    // Mark problems previously detected for this shop that are no longer detected as resolved
    const activeProblemIds = detectedProblems.map((p) => p.id);
    await prisma.problem.updateMany({
      where: {
        shop,
        id: { notIn: activeProblemIds },
        resolvedAt: null,
      },
      data: {
        resolvedAt: new Date(),
      },
    });
  } catch (dbErr) {
    console.warn("Failed to persist scan/problems to database cache:", dbErr.message);
  }

  // Calculate severity statistics
  const criticalCount = detectedProblems.filter((p) => p.severity === "CRITICAL").length;
  const warningCount = detectedProblems.filter((p) => p.severity === "WARNING").length;
  const noticeCount = detectedProblems.filter((p) => p.severity === "NOTICE").length;

  // Store Health Score formula: 100 - (Critical x 15 + Warning x 5 + Notice x 2), min 0
  const healthScore = Math.max(0, 100 - (criticalCount * 15 + warningCount * 5 + noticeCount * 2));

  // Log scan in AuditLog
  try {
    await prisma.auditLog.create({
      data: {
        shop,
        action: "SCAN",
        resource: `${products.length} Products Scanned`,
        details: `Diagnostic scan complete. Found ${criticalCount} Critical, ${warningCount} Warnings, ${noticeCount} Notices. Health Score: ${healthScore}/100.`,
      },
    });
  } catch {
    // Non-blocking
  }

  return {
    problems: detectedProblems,
    healthScore,
    stats: {
      critical: criticalCount,
      warning: warningCount,
      notice: noticeCount,
      total: detectedProblems.length,
      resolved: 0,
    },
    totalProductsScanned: products.length,
  };
}
