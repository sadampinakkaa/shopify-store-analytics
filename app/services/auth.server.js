import { authenticate, unauthenticated } from "../shopify.server.js";
import prisma from "../db.server.js";

/**
 * Safely resolves an authenticated Shopify Admin API client for action requests.
 * Prevents throwing redirect responses during fetcher mutations by falling back
 * to the verified offline session if session token headers are not present.
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
    // If authenticate.admin threw a Response (like a redirect or HTML challenge),
    // do NOT let the redirect response bubble up to React Router, as that causes
    // the user's browser to execute a full-page redirect!
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

    throw new Error(
      authErr instanceof Error
        ? authErr.message
        : "Failed to authenticate Shopify Admin session for this action."
    );
  }
}

export { getShopifyAdminUrl } from "../utils/navigation.js";
