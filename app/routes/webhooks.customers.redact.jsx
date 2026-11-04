import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "[Store Analytics Webhook] Authentication failed for customers/redact:",
      error?.message || error
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const { shop, topic } = webhook;
  console.log(`[Store Analytics Compliance] Received ${topic} for ${shop}`);

  // Store Analytics does not store customer personal identifiable information (PII).
  // No customer records to redact.
  return new Response("OK", { status: 200 });
};
