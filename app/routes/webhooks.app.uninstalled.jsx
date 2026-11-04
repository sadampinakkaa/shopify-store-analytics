import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "[Store Analytics Webhook] Authentication failed for app/uninstalled:",
      error?.message || error
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const { shop, session, topic } = webhook;

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
