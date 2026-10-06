import { resendClient } from "./resend";
import { ensureTestRecipient, type Site } from "./config";
import { digest, newToken, rateLimit } from "./security";
import { page } from "./views";
import { escapeHtml as e } from "../../../src/features/latest-updates/markdown";

export const consentVersion = "latest-updates-2026-10-06";
export async function requestSubscription(
  request: Request,
  env: RuntimeEnv,
  site: Site,
) {
  const fields = new URLSearchParams(await request.text());
  const email = (fields.get("email") || "").trim().toLowerCase();
  const generic = new Response("Check your email for a confirmation link.", {
    status: 202,
    headers: {
      "Access-Control-Allow-Origin": site.origin,
      Vary: "Origin",
      "Cache-Control": "no-store",
    },
  });
  if (
    fields.get("website") ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    email.length > 254
  )
    return generic;
  const source = await digest(
    request.headers.get("cf-connecting-ip") || "local",
  );
  if (
    !(await rateLimit(env, `source:${source}`, 20)) ||
    !(await rateLimit(env, `email:${await digest(email)}`, 3))
  )
    return generic;
  if (env.DELIVERY_PAUSED === "true")
    return new Response("Temporarily unavailable", {
      status: 503,
      headers: { "Access-Control-Allow-Origin": site.origin },
    });
  ensureTestRecipient(env, email);
  if (!site.sender || !env.RESEND_API_KEY)
    throw new Error("subscription_setup_incomplete");
  const id = crypto.randomUUID(),
    token = newToken(),
    now = Date.now();
  await env.DB.prepare(
    "INSERT INTO subscriptions(id,site,email,token_hash,expires,consent_version,created) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      site.id,
      email,
      await digest(token),
      now + 86400000,
      consentVersion,
      now,
    )
    .run();
  const url = `${site.serviceOrigin}/subscriptions/${token}`;
  try {
    const { error } = await resendClient(env).emails.send(
      {
        from: site.sender,
        to: email,
        subject: `Confirm ${site.name} Latest Updates`,
        text: `Confirm your subscription to ${site.name} Latest Updates: ${url}\nThis invitation expires in 24 hours. Ignore it if you did not request it.`,
        html: `<h1>${e(site.name)} Latest Updates</h1><p><a href="${e(url)}">Review and confirm your subscription</a></p><p>This invitation expires in 24 hours. Ignore it if you did not request it.</p>`,
      },
      { idempotencyKey: `subscription-${id}` },
    );
    if (error) throw new Error("confirmation_send_failed");
  } catch {
    await env.DB.prepare(
      "UPDATE subscriptions SET state='needs_attention' WHERE id=?",
    )
      .bind(id)
      .run();
  }
  return generic;
}
interface Subscription {
  id: string;
  email: string;
  site: string;
  expires: number;
  state: string;
}
export async function subscriptionRoute(
  request: Request,
  env: RuntimeEnv,
  site: Site,
  token: string,
) {
  const item = await env.DB.prepare(
    "SELECT * FROM subscriptions WHERE token_hash=? AND site=?",
  )
    .bind(await digest(token), site.id)
    .first<Subscription>();
  if (!item || item.expires < Date.now())
    return page(
      site,
      "Invitation unavailable",
      "<h1>Invitation unavailable</h1><p>Please request another confirmation.</p>",
    );
  if (request.method === "GET")
    return page(
      site,
      "Confirm subscription",
      `<h1>Subscribe to ${e(site.name)} Latest Updates</h1><p>You’ll receive future posts by email. You can unsubscribe at any time.</p><form method="post"><button>Confirm subscription</button></form>`,
    );
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== site.serviceOrigin
  )
    return new Response("Forbidden", { status: 403 });
  const claimed = await env.DB.prepare(
    "UPDATE subscriptions SET state='confirming',confirmed=? WHERE id=? AND state='pending' AND expires>? RETURNING id",
  )
    .bind(Date.now(), item.id, Date.now())
    .first();
  if (!claimed)
    return page(
      site,
      "Subscription status",
      "<h1>Confirmation already processed</h1><p>If you did not receive confirmation, request a new invitation.</p>",
    );
  const resend = resendClient(env);
  try {
    const suppressed = await env.DB.prepare(
      "SELECT email FROM suppressions WHERE email=?",
    )
      .bind(item.email)
      .first();
    const existing = await resend.contacts.get(item.email);
    if (existing.error && existing.error.name !== "not_found")
      throw new Error("contact_lookup_failed");
    if (suppressed || existing.data?.unsubscribed) {
      await env.DB.prepare(
        "UPDATE subscriptions SET state='suppressed' WHERE id=?",
      )
        .bind(item.id)
        .run();
      return page(
        site,
        "Subscription preferences",
        "<h1>Please review your email preferences</h1><p>Your existing unsubscribe preference remains in effect. Contact us if you wish to change it.</p>",
      );
    }
    let contactId = existing.data?.id;
    if (!contactId) {
      const created = await resend.contacts.create({
        email: item.email,
        unsubscribed: false,
      });
      if (created.error) throw new Error("contact_creation_failed");
      contactId = created.data!.id;
    }
    const segment = await resend.contacts.segments.add({
      contactId,
      segmentId: site.segmentId,
    });
    if (segment.error) throw new Error("segment_update_failed");
    const preference = await resend.contacts.topics.update({
      id: contactId,
      topics: [{ id: site.topicId, subscription: "opt_in" }],
    });
    if (preference.error) throw new Error("topic_update_failed");
    await env.DB.prepare(
      "UPDATE subscriptions SET state='confirmed' WHERE id=?",
    )
      .bind(item.id)
      .run();
    return page(
      site,
      "Subscribed",
      `<h1>You’re subscribed</h1><p>You’ll receive future ${e(site.name)} posts. Older posts will not be sent.</p>`,
    );
  } catch {
    // Preference writes are not replayed automatically: a later opt-out must never be overwritten.
    await env.DB.prepare(
      "UPDATE subscriptions SET state='needs_attention' WHERE id=?",
    )
      .bind(item.id)
      .run();
    return page(
      site,
      "Confirmation pending",
      "<h1>We’re checking your confirmation</h1><p>Please try a fresh invitation later if confirmation does not arrive.</p>",
    );
  }
}
export async function resendWebhook(request: Request, env: RuntimeEnv) {
  const raw = await request.text();
  const event = resendClient(env).webhooks.verify({
    payload: raw,
    headers: {
      id: request.headers.get("svix-id")!,
      timestamp: request.headers.get("svix-timestamp")!,
      signature: request.headers.get("svix-signature")!,
    },
    webhookSecret: env.RESEND_WEBHOOK_SECRET,
  });
  const id = request.headers.get("svix-id")!;
  if (await env.DB.prepare("SELECT id FROM events WHERE id=?").bind(id).first())
    return new Response("OK");
  // The provider remains authoritative. We never replay opt-in from webhook payloads.
  const data = event.data as any;
  if (
    event.type === "email.bounced" ||
    event.type === "email.complained" ||
    (event.type === "contact.updated" && data.unsubscribed)
  ) {
    const recipients = Array.isArray(data.to)
      ? data.to
      : [data.email].filter(Boolean);
    for (const email of recipients)
      await env.DB.prepare(
        "INSERT INTO suppressions(email,reason,observed) VALUES (?,?,?) ON CONFLICT(email) DO UPDATE SET reason=excluded.reason,observed=MAX(observed,excluded.observed)",
      )
        .bind(email.toLowerCase(), event.type, Date.now())
        .run();
  }
  await env.DB.prepare(
    "INSERT OR IGNORE INTO events(id,kind,created) VALUES (?,'resend',?)",
  )
    .bind(id, Date.now())
    .run();
  return new Response("OK");
}
