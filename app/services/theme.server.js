import prisma from "../db.server.js";

// ─── THEME SCANNER & SAFETY SERVICE ──────────────────────────────────────────
// Hard Safety Rule: Scans only the explicitly selected theme.
// Never modifies live theme unintentionally.

export async function getStoreThemes(admin, shop) {
  // Ensure store exists in DB
  await prisma.store.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });

  try {
    const res = await admin.graphql(
      `#graphql
      query getStoreThemesList {
        themes(first: 25) {
          edges {
            node {
              id
              name
              role
              createdAt
              updatedAt
            }
          }
        }
      }`
    );
    const json = await res.json();
    const rawThemes = json.data?.themes?.edges?.map((e) => e.node) ?? [];

    const themes = [];
    for (const t of rawThemes) {
      const isLive = t.role?.toUpperCase() === "MAIN";
      // Upsert into local Prisma cache
      const dbTheme = await prisma.theme.upsert({
        where: {
          shop_shopifyId: {
            shop,
            shopifyId: t.id,
          },
        },
        create: {
          shop,
          shopifyId: t.id,
          name: t.name,
          role: t.role?.toLowerCase() || "unpublished",
        },
        update: {
          name: t.name,
          role: t.role?.toLowerCase() || "unpublished",
        },
      });

      themes.push({
        id: dbTheme.id,
        shopifyId: t.id,
        name: t.name,
        role: t.role?.toUpperCase() || "UNPUBLISHED",
        isLive,
        updatedAt: t.updatedAt,
      });
    }

    return themes;
  } catch (err) {
    console.error("Failed to query store themes:", err.message);
    return [];
  }
}

export async function scanTheme(admin, shop, themeShopifyId) {
  if (!themeShopifyId) {
    throw new Error("Safety Check Failed: themeId must be explicitly provided.");
  }

  // Find theme in DB
  const dbTheme = await prisma.theme.findFirst({
    where: { shop, shopifyId: themeShopifyId },
  });

  const liquidIssues = [];
  const jsIssues = [];
  const cssIssues = [];
  const assetIssues = [];
  const ghostScripts = [];

  let totalFiles = 0;
  let totalAssetSizeBytes = 0;

  try {
    // Read theme files (read-only query)
    const res = await admin.graphql(
      `#graphql
      query inspectThemeFiles($id: ID!) {
        theme(id: $id) {
          id
          name
          role
          files(first: 100) {
            edges {
              node {
                filename
                size
                contentType
              }
            }
          }
        }
      }`,
      {
        variables: { id: themeShopifyId },
      }
    );
    const json = await res.json();
    const files = json.data?.theme?.files?.edges?.map((e) => e.node) ?? [];
    totalFiles = files.length;

    for (const f of files) {
      const sizeBytes = f.size || 0;
      totalAssetSizeBytes += sizeBytes;
      const sizeKb = Math.round(sizeBytes / 1024);
      const filename = f.filename || "";

      // 1. JavaScript audit
      if (filename.endsWith(".js") && !filename.includes(".json")) {
        if (sizeKb > 120) {
          jsIssues.push({
            file: filename,
            size: `${sizeKb} KB`,
            severity: sizeKb > 250 ? "CRITICAL" : "WARNING",
            issue: `Large JavaScript payload (${sizeKb} KB) delays execution and main-thread readiness.`,
            recommendation: "Split code, minify with Terser, or defer loading.",
          });
        }
        if (!filename.includes(".min.") && sizeKb > 30) {
          jsIssues.push({
            file: filename,
            size: `${sizeKb} KB`,
            severity: "WARNING",
            issue: "Unminified JavaScript file detected.",
            recommendation: "Minify before deploying to production.",
          });
        }
      }

      // 2. CSS audit
      if (filename.endsWith(".css")) {
        if (sizeKb > 80) {
          cssIssues.push({
            file: filename,
            size: `${sizeKb} KB`,
            severity: "WARNING",
            issue: `Heavy stylesheet (${sizeKb} KB) increases render-blocking time.`,
            recommendation: "Extract critical CSS and purge unused class selectors.",
          });
        }
      }

      // 3. Asset audit
      if (filename.startsWith("assets/") && (filename.endsWith(".png") || filename.endsWith(".jpg") || filename.endsWith(".jpeg"))) {
        if (sizeKb > 400) {
          assetIssues.push({
            file: filename,
            size: `${sizeKb} KB`,
            severity: "WARNING",
            issue: `Uncompressed image asset (${sizeKb} KB).`,
            recommendation: "Convert to WebP or AVIF and compress below 150 KB.",
          });
        }
      }
    }

    // Inspect theme.liquid for ghost scripts and liquid patterns
    try {
      const liquidRes = await admin.graphql(
        `#graphql
        query inspectThemeLiquid($id: ID!) {
          theme(id: $id) {
            files(first: 1, filenames: ["layout/theme.liquid"]) {
              edges {
                node {
                  filename
                  body {
                    ... on OnlineStoreThemeFileBodyText {
                      content
                    }
                  }
                }
              }
            }
          }
        }`,
        { variables: { id: themeShopifyId } }
      );
      const liquidJson = await liquidRes.json();
      const liquidContent =
        liquidJson.data?.theme?.files?.edges?.[0]?.node?.body?.content || "";

      if (liquidContent) {
        // Check for deprecated include tag
        const includeMatches = liquidContent.match(/{%\s*include\s+['"][^'"]+['"]\s*%}/g) || [];
        if (includeMatches.length > 0) {
          liquidIssues.push({
            file: "layout/theme.liquid",
            severity: "WARNING",
            issue: `Found ${includeMatches.length} deprecated '{% include %}' tag(s).`,
            recommendation: "Upgrade to '{% render %}' for isolated variable scoping and faster compilation.",
          });
        }

        // Check for ghost tracking / external scripts
        const scriptMatches = liquidContent.match(/<script[^>]*src=["']([^"']+)["'][^>]*>/gi) || [];
        if (scriptMatches.length > 3) {
          ghostScripts.push({
            file: "layout/theme.liquid",
            count: scriptMatches.length,
            severity: "NOTICE",
            issue: `Detected ${scriptMatches.length} external third-party script tags in theme.liquid header.`,
            recommendation: "Audit installed apps and remove lingering tags from uninstalled apps.",
          });
        }
      }
    } catch (lErr) {
      console.warn("Could not inspect layout/theme.liquid content:", lErr.message);
    }
  } catch (err) {
    console.error("Theme inspection error:", err.message);
  }

  // Calculate theme health score
  const totalWarnings =
    liquidIssues.length + jsIssues.length + cssIssues.length + assetIssues.length;
  const totalCritical = jsIssues.filter((i) => i.severity === "CRITICAL").length;
  const themeScore = Math.max(0, 100 - (totalCritical * 20 + totalWarnings * 4 + ghostScripts.length * 3));

  // Persist scan in Prisma
  if (dbTheme) {
    await prisma.themeScan.create({
      data: {
        shop,
        themeId: dbTheme.id,
        status: "complete",
        liquidIssues: liquidIssues.length,
        jsIssues: jsIssues.length,
        cssIssues: cssIssues.length,
        assetIssues: assetIssues.length,
        ghostScripts: ghostScripts.length,
        rawResults: JSON.stringify({
          score: themeScore,
          liquidIssues,
          jsIssues,
          cssIssues,
          assetIssues,
          ghostScripts,
          totalFiles,
          totalAssetSizeBytes,
        }),
      },
    });
  }

  return {
    themeShopifyId,
    themeName: dbTheme?.name || "Selected Theme",
    isLive: dbTheme?.role === "main",
    themeScore,
    totalFiles,
    totalSizeMb: (totalAssetSizeBytes / (1024 * 1024)).toFixed(2),
    counts: {
      liquid: liquidIssues.length,
      js: jsIssues.length,
      css: cssIssues.length,
      assets: assetIssues.length,
      ghost: ghostScripts.length,
      totalIssues:
        liquidIssues.length +
        jsIssues.length +
        cssIssues.length +
        assetIssues.length +
        ghostScripts.length,
    },
    liquidIssues,
    jsIssues,
    cssIssues,
    assetIssues,
    ghostScripts,
  };
}
