/**
 * Direct Shopify Admin navigation and link generation.
 * This is safe to import on both client and server (does not contain server-only secrets).
 */

/**
 * Generates the modern, direct Shopify Admin URL for a resource
 * (e.g. https://admin.shopify.com/store/<handle>/products/<id>)
 * which avoids legacy 302 redirect loops inside or outside iframe.
 */
export function getShopifyAdminUrl(shop, resourceType = "products", resourceId = "") {
  if (!shop) return "#";
  const storeHandle = shop.replace(".myshopify.com", "");
  const numericId = String(resourceId).replace(/\D/g, "");
  if (!numericId) {
    return `https://admin.shopify.com/store/${storeHandle}/${resourceType}`;
  }
  return `https://admin.shopify.com/store/${storeHandle}/${resourceType}/${numericId}`;
}
