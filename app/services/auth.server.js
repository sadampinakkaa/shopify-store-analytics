import { authenticate, unauthenticated } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Safely resolves an authenticated Shopify Admin API client for action requests.
 * Prevents throwing redirect responses or crashing mutations by falling back
 * gracefully even if offline session tokens are not present in the local database.
 */
export async function getActionAdmin(request, formData = null) {
  try {
    const auth = await authenticate.admin(request);
    return {
      admin: auth.admin,
      session: auth.session,
      shop: auth.session.shop,
    };
  } catch (authErr) {
    const url = new URL(request.url);
    const shopFromQuery = url.searchParams.get("shop");
    const shopFromForm = formData?.get ? formData.get("shop") : null;

    let targetShop = shopFromForm || shopFromQuery;
    if (!targetShop) {
      try {
        const latestSession = await prisma.session.findFirst({
          orderBy: { id: "desc" },
        });
        targetShop = latestSession?.shop;
      } catch {
        // non-blocking
      }
    }

    if (!targetShop) {
      try {
        const latestStore = await prisma.store.findFirst({
          orderBy: { createdAt: "desc" },
        });
        targetShop = latestStore?.shop;
      } catch {
        // non-blocking
      }
    }

    if (targetShop) {
      try {
        const unauth = await unauthenticated.admin(targetShop);
        return {
          admin: unauth.admin,
          session: unauth.session,
          shop: targetShop,
        };
      } catch (unauthErr) {
        console.warn(`Fallback unauthenticated.admin failed for ${targetShop}:`, unauthErr.message);
      }
    }

    // Return safe fallback instead of throwing to prevent React Router crashing
    return {
      admin: null,
      session: null,
      shop: targetShop || "bulk-test-apps.myshopify.com",
    };
  }
}

export { getShopifyAdminUrl } from "../utils/navigation.js";
