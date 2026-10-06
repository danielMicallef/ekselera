import { EmailMessage } from "cloudflare:email";
import { createMimeMessage } from "mimetext";
import { sites, authorFor, ready, type Site } from "./config";
import { parseIncoming } from "./content";
import { digest, newToken, signedCallback, rateLimit } from "./security";
import { jobById, updateJob, enqueue, lock, draftOf, type Job } from "./store";
import { page, preview } from "./views";
import { openPublication, inspectPublication } from "./github";
import { verifyProduction, notifyLive, notifyFailure } from "./delivery";
import {
  requestSubscription,
  subscriptionRoute,
  resendWebhook,
} from "./subscriptions";

async function boundedBody(stream: ReadableStream, maximum: number) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = [],
    total = { value: 0 };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total.value += value.byteLength;
    if (total.value > maximum) {
      await reader.cancel();
      throw new Error("body_too_large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total.value);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
async function receive(message: ForwardableEmailMessage, env: RuntimeEnv) {
  if (env.PUBLISHING_PAUSED === "true") {
    message.setReject("Publishing is paused");
    return;
  }
  const site = sites(env).find(
    (s) => s.recipient.toLowerCase() === message.to.toLowerCase(),
  );
  if (!site || message.rawSize > 10 * 1024 * 1024) {
    message.setReject("Unknown destination or message exceeds 10 MiB");
    return;
  }
  try {
    ready(site);
    if (!authorFor(env, site, message.from)) {
      message.setReject("Unauthorized sender");
      return;
    }
    if (
      !(await rateLimit(
        env,
        `author:${await digest(message.from.toLowerCase())}`,
        20,
      ))
    )
      throw new Error("author_rate_limited");
    const bytes = await boundedBody(message.raw, 10 * 1024 * 1024),
      id = crypto.randomUUID();
    const parsed = await parseIncoming(
      bytes.buffer as ArrayBuffer,
      { from: message.from, to: message.to },
      site,
      env,
      id,
    );
    const inputDigest = await digest(
      JSON.stringify({
        title: parsed.draft.title,
        author: message.from.toLowerCase(),
        recipient: site.recipient,
        attachments: (
          await Promise.all(
            parsed.email.attachments.map(async (item) => ({
              name: item.filename,
              digest: await digest(new Uint8Array(item.content as ArrayBuffer)),
            })),
          )
        ).sort((a, b) => String(a.name).localeCompare(String(b.name))),
      }),
    );
    const existing = await env.DB.prepare(
      "SELECT * FROM jobs WHERE message_key=?",
    )
      .bind(parsed.messageKey)
      .first<Job>();
    if (existing) {
      if (existing.input_digest !== inputDigest)
        throw new Error("Message-ID reused with different content");
      return;
    }
    const token = newToken(),
      now = Date.now();
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO jobs(id,site,author,message_key,input_digest,digest,token_hash,state,draft,expires,created,updated) VALUES (?,?,?,?,?,?,?,'inviting',?,?,?,?)",
    )
      .bind(
        id,
        site.id,
        message.from.toLowerCase(),
        parsed.messageKey,
        inputDigest,
        parsed.contentDigest,
        await digest(token),
        JSON.stringify(parsed.draft),
        now + 86400000,
        now,
        now,
      )
      .run();
    if (!inserted.meta.changes) {
      const duplicate = await env.DB.prepare(
        "SELECT input_digest FROM jobs WHERE message_key=?",
      )
        .bind(parsed.messageKey)
        .first<{ input_digest: string }>();
      if (duplicate?.input_digest !== inputDigest)
        throw new Error("Message-ID reused with different content");
      return;
    }
    for (const image of parsed.images)
      await env.DRAFTS.put(image.key, image.bytes, {
        httpMetadata: { contentType: image.type },
      });
    const reply = createMimeMessage();
    reply.setSender(site.recipient);
    reply.setRecipient(message.from);
    reply.setSubject(`Review your ${site.name} article`);
    reply.setHeader("In-Reply-To", parsed.email.messageId!);
    reply.setHeader("References", parsed.email.messageId!);
    reply.addMessage({
      contentType: "text/plain",
      data: `Your article is destined for ${site.name}. Review it and explicitly approve publication:\n${site.serviceOrigin}/draft/${token}\n\nExpires in 24 hours. Opening this link does not publish.`,
    });
    // Cloudflare's receiver-enforced DMARC gate is mandatory. Never fall back to Resend here.
    const result = await message.reply(
      new EmailMessage(site.recipient, message.from, reply.asRaw()),
    );
    if (!result.messageId) throw new Error("reply_not_accepted");
    await updateJob(env, id, { state: "awaiting_confirmation" });
  } catch (error) {
    // Expire all invitations that could not pass the reply gate; never log body, token, or mailbox.
    const key = message.headers.get("message-id");
    if (key) {
      const messageKey = await digest(
        `${site.id}:${message.from.toLowerCase()}:${key}`,
      );
      await env.DB.prepare(
        "UPDATE jobs SET state='failed',error_code='invitation_failed',updated=? WHERE message_key=? AND state='inviting'",
      )
        .bind(Date.now(), messageKey)
        .run();
    }
    console.warn(
      JSON.stringify({
        event: "email_rejected",
        site: site.id,
        code: "validation_or_reply_failed",
      }),
    );
    message.setReject(
      error instanceof Error && !/^github_/.test(error.message)
        ? error.message
        : "Invitation failed",
    );
  }
}
async function authorizedDraft(env: RuntimeEnv, site: Site, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const job = await env.DB.prepare(
    "SELECT * FROM jobs WHERE token_hash=? AND site=?",
  )
    .bind(await digest(token), site.id)
    .first<Job>();
  if (
    !job ||
    ["inviting", "discarded", "expired"].includes(job.state) ||
    (job.state === "failed" && !job.published_at) ||
    job.expires < Date.now() ||
    !authorFor(env, site, job.author)
  )
    return null;
  const draft = draftOf(job);
  const actual = await digest(
    JSON.stringify({
      title: draft.title,
      authorId: draft.authorId,
      markdown: draft.markdown,
      media: draft.images.map(({ name, digest }) => ({ name, digest })),
    }),
  );
  if (
    actual !== job.digest ||
    authorFor(env, site, job.author)?.id !== draft.authorId
  )
    return null;
  return job;
}
async function advance(env: RuntimeEnv, id: string) {
  if (!(await lock(env, id))) return;
  try {
    let job = await jobById(env, id);
    if (!job) return;
    const site = sites(env).find((s) => s.id === job!.site);
    if (!site) return;
    if (["failed", "needs_attention"].includes(job.state) && job.published_at) {
      await notifyFailure(env, site, job);
      if (job.error_code === "retry_exhausted")
        throw new Error("retry_exhausted");
      return;
    }
    if (
      job.published_at &&
      job.state !== "live" &&
      Date.now() - Date.parse(job.published_at) > 6 * 3600000 &&
      env.PUBLISHING_PAUSED !== "true"
    ) {
      await updateJob(env, id, {
        state: "needs_attention",
        error_code: "publication_timeout",
      });
      return;
    }
    if (
      ["confirmed", "opening_pr", "validating", "merging"].includes(
        job.state,
      ) &&
      authorFor(env, site, job.author)?.id !== draftOf(job).authorId
    )
      throw new Error("author_revoked");
    if (["confirmed", "opening_pr"].includes(job.state)) {
      if (env.PUBLISHING_PAUSED === "true") return;
      if (!authorFor(env, site, job.author)) throw new Error("author_revoked");
      await openPublication(env, site, job);
    } else if (["validating", "merging"].includes(job.state)) {
      if (env.PUBLISHING_PAUSED === "true") return;
      await inspectPublication(env, site, job);
    }
    job = (await jobById(env, id))!;
    if (job.state === "deploying" && (await verifyProduction(site, job))) {
      await updateJob(env, id, { state: "live" });
      job.state = "live";
    }
    if (job.state === "live") await notifyLive(env, site, job);
    if (job.state === "live")
      await env.DB.prepare("UPDATE outbox SET state='complete' WHERE job_id=?")
        .bind(id)
        .run();
  } catch (error) {
    const code = error instanceof Error ? error.message : "processing_failed";
    if (
      /^(unexpected_|draft_media_|author_revoked|merge_not_completed|validation_failed)/.test(
        code,
      )
    )
      await updateJob(env, id, {
        state: code === "validation_failed" ? "failed" : "needs_attention",
        error_code: code,
      });
    else {
      const row = await env.DB.prepare(
        "UPDATE jobs SET retry_count=retry_count+1 WHERE id=? RETURNING retry_count",
      )
        .bind(id)
        .first<{ retry_count: number }>();
      if (row && row.retry_count >= 6)
        await updateJob(env, id, {
          state: "needs_attention",
          error_code: "retry_exhausted",
        });
      console.warn(
        JSON.stringify({
          event: "job_retry",
          id,
          code: "upstream_or_processing_failure",
        }),
      );
      throw error;
    }
  } finally {
    await env.DB.prepare("UPDATE jobs SET lease_until=0 WHERE id=?")
      .bind(id)
      .run();
  }
}
async function reconcile(env: RuntimeEnv) {
  const now = Date.now();
  await env.DB.prepare(
    "UPDATE jobs SET state='expired',updated=? WHERE state IN ('inviting','awaiting_confirmation') AND expires<?",
  )
    .bind(now, now)
    .run();
  const pending = await env.DB.prepare(
    "SELECT id FROM jobs WHERE state IN ('confirmed','opening_pr','validating','merging','deploying') OR (state='live' AND notification_state NOT IN ('sent','needs_attention')) ORDER BY updated LIMIT 50",
  ).all<{ id: string }>();
  for (const job of pending.results) await env.JOBS.send({ id: job.id });
  const alerts = await env.DB.prepare(
    "SELECT * FROM jobs WHERE state IN ('failed','needs_attention') AND published_at IS NOT NULL AND notification_state='pending' LIMIT 20",
  ).all<Job>();
  for (const job of alerts.results) {
    const site = sites(env).find((s) => s.id === job.site);
    if (site) await notifyFailure(env, site, job);
  }
  // R2 is private; clean temporary blobs after seven days, keeping publication ledger rows.
  const old = await env.DB.prepare(
    "SELECT id FROM jobs WHERE cleaned_at IS NULL AND created<? AND state IN ('live','failed','expired','discarded','needs_attention') ORDER BY created LIMIT 50",
  )
    .bind(now - 7 * 86400000)
    .all<{ id: string }>();
  for (const job of old.results) {
    const objects = await env.DRAFTS.list({ prefix: `${job.id}/` });
    if (objects.objects.length)
      await env.DRAFTS.delete(objects.objects.map((o) => o.key));
    const record = await jobById(env, job.id);
    if (record) {
      const draft = draftOf(record);
      draft.markdown = "";
      await updateJob(env, job.id, {
        draft: JSON.stringify(draft),
        cleaned_at: now,
      });
    }
  }
  await env.DB.prepare("DELETE FROM rate_limits WHERE expires<?")
    .bind(now)
    .run();
  await env.DB.prepare(
    "DELETE FROM subscriptions WHERE expires<? AND state IN ('pending','needs_attention')",
  )
    .bind(now - 7 * 86400000)
    .run();
}
async function http(request: Request, env: RuntimeEnv) {
  const url = new URL(request.url),
    site = sites(env).find((s) => new URL(s.serviceOrigin).host === url.host);
  if (!site) return new Response("Unknown host", { status: 421 });
  if (
    request.method === "GET" &&
    /^\/fonts\/[a-z0-9-]+\.woff2$/.test(url.pathname)
  )
    return env.ASSETS.fetch(request);
  if (request.method === "OPTIONS" && url.pathname === "/subscriptions") {
    if (request.headers.get("origin") !== site.origin)
      return new Response("Forbidden", { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": site.origin,
        "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "content-type",
        Vary: "Origin",
      },
    });
  }
  if (request.method === "POST") {
    const size = Number(request.headers.get("content-length") || 0);
    if (size > 65536) return new Response("Too large", { status: 413 });
    // Clone into a bounded body before handlers parse form data or webhook JSON.
    const body = await boundedBody(request.body!, 65536);
    request = new Request(request, { body: body as BodyInit });
  }
  if (url.pathname === "/subscriptions" && request.method === "POST") {
    if (request.headers.get("origin") !== site.origin)
      return new Response("Forbidden", { status: 403 });
    return requestSubscription(request, env, site);
  }
  const subscription = url.pathname.match(/^\/subscriptions\/([a-f0-9]{64})$/);
  if (subscription)
    return subscriptionRoute(request, env, site, subscription[1]);
  if (url.pathname === "/webhooks/resend" && request.method === "POST")
    return resendWebhook(request, env);
  if (url.pathname === "/callbacks/ci" && request.method === "POST") {
    const body = await request.text();
    if (!(await signedCallback(request, env.CI_CALLBACK_SECRET, body)))
      return new Response("Forbidden", { status: 403 });
    const payload = JSON.parse(body);
    if (
      typeof payload.eventId !== "string" ||
      typeof payload.jobId !== "string"
    )
      return new Response("Invalid", { status: 400 });
    const job = await jobById(env, payload.jobId);
    if (!job || job.site !== site.id)
      return new Response("Invalid job", { status: 400 });
    const inserted = await env.DB.prepare(
      "INSERT OR IGNORE INTO events(id,kind,created) VALUES (?,'ci',?)",
    )
      .bind(payload.eventId, Date.now())
      .run();
    if (inserted.meta.changes) await enqueue(env, job);
    return new Response("Accepted", { status: 202 });
  }
  const match = url.pathname.match(
    /^\/draft\/([a-f0-9]{64})(?:\/(publish|discard|media\/[^/]+))?$/,
  );
  if (match) {
    const job = await authorizedDraft(env, site, match[1]);
    if (!job)
      return page(
        site,
        "Invitation unavailable",
        "<h1>Invitation unavailable</h1><p>Request a new invitation from your approved mailbox.</p>",
        404,
      );
    const action = match[2];
    if (request.method === "GET" && !action)
      return preview(site, job, match[1]);
    if (request.method === "GET" && action?.startsWith("media/")) {
      const name = decodeURIComponent(action.slice(6));
      const image = draftOf(job).images.find((i) => i.name === name);
      if (!image) return new Response("Not found", { status: 404 });
      const object = await env.DRAFTS.get(image.key);
      return object
        ? new Response(object.body, {
            headers: {
              "Content-Type": image.type,
              "Cache-Control": "no-store",
              "X-Robots-Tag": "noindex",
              "Referrer-Policy": "no-referrer",
              "X-Content-Type-Options": "nosniff",
            },
          })
        : new Response("Not found", { status: 404 });
    }
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== site.serviceOrigin
    )
      return new Response("Forbidden", { status: 403 });
    if (action === "discard")
      await env.DB.prepare(
        "UPDATE jobs SET state='discarded',updated=? WHERE id=? AND state='awaiting_confirmation'",
      )
        .bind(Date.now(), job.id)
        .run();
    else if (action === "publish") {
      if (env.PUBLISHING_PAUSED === "true")
        return page(
          site,
          "Publishing paused",
          "<h1>Publishing is paused</h1><p>Please try again after the service resumes.</p>",
          503,
        );
      const now = Date.now();
      const claimed = await env.DB.prepare(
        "UPDATE jobs SET state='confirmed',published_at=?,updated=? WHERE id=? AND state='awaiting_confirmation' AND expires>? RETURNING id",
      )
        .bind(new Date(now).toISOString(), now, job.id, now)
        .first();
      if (claimed) await enqueue(env, job);
    } else return new Response("Not found", { status: 404 });
    return Response.redirect(`${site.serviceOrigin}/draft/${match[1]}`, 303);
  }
  return page(
    site,
    "Publishing service",
    "<h1>Latest Updates publishing</h1><p>Use the private invitation sent to your authorized mailbox.</p>",
  );
}
export default {
  email: receive,
  async fetch(request, env) {
    try {
      return await http(request, env);
    } catch {
      console.warn(JSON.stringify({ event: "request_failed" }));
      return new Response("Request could not be processed", {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      });
    }
  },
  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await advance(env, (message.body as { id: string }).id);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 120 });
      }
    }
  },
  async scheduled(_event, env) {
    await reconcile(env);
  },
} satisfies ExportedHandler<RuntimeEnv>;
