import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let webhook;
  try {
    webhook = await authenticate.webhook(request);
  } catch (error) {
    if (error instanceof Response) return error;
    console.error(
      "[Store Analytics Webhook] Authentication failed for app/scopes_update:",
      error?.message || error
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const { payload, session, topic, shop } = webhook;

  console.log(`Received ${topic} webhook for ${shop}`);
  const current = payload?.current;

  if (session && current) {
    await db.session.update({
      where: {
        id: session.id,
      },
      data: {
        scope: current.toString(),
      },
    });
  }

  return new Response();
};
