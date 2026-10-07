import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare } from "miniflare";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { digest } from "../src/security";
import { createHmac } from "node:crypto";
const token = "a".repeat(64),
  id = "11111111-1111-4111-8111-111111111111";
const site = {
  id: "ekselera",
  name: "Ekselera",
  recipient: "post@publish.ekselera.com",
  serviceOrigin: "https://publishing.example.com",
  origin: "https://site.example.com",
  contentPrefix: "src/content/updates/",
  mediaPrefix: "public/latest-updates/media/",
  branch: "main",
  accent: "#1a56db",
  background: "#fff",
};
async function fixture(
  author = true,
  options: { expired?: boolean; modified?: boolean; state?: string } = {},
) {
  const mf = new Miniflare({
    modules: true,
    scriptPath: resolve(".wrangler/updates-tests/index.js"),
    modulesRoot: resolve(".wrangler/updates-tests"),
    modulesRules: [{ type: "Text", include: ["**/*.css"] }],
    compatibilityDate: "2026-10-06",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    r2Buckets: ["DRAFTS"],
    queueProducers: { JOBS: "test-publications" },
    bindings: {
      ENVIRONMENT: "production",
      PUBLISHING_PAUSED: "false",
      DELIVERY_PAUSED: "true",
      RESEND_API_KEY: "test-only",
      RESEND_WEBHOOK_SECRET: `whsec_${Buffer.alloc(32, 7).toString("base64")}`,
      SITES_JSON: JSON.stringify([site]),
      AUTHORS_JSON: JSON.stringify(
        author
          ? [
              {
                id: "writer",
                email: "writer@example.com",
                name: "Writer",
                sites: ["ekselera"],
              },
            ]
          : [],
      ),
    },
  });
  let db;
  try {
    db = await mf.getD1Database("DB");
  } catch (error) {
    await mf.dispose();
    throw error;
  }
  const directory = "workers/latest-updates-publisher/migrations";
  for (const name of (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const schema = await readFile(`${directory}/${name}`, "utf8");
    for (const statement of schema
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await db.prepare(statement).run();
  }
  const draft = {
    id,
    slug: "new-update-11111111",
    title: "New update",
    authorId: "writer",
    authorName: "Writer",
    summary: "Opening prose.",
    markdown: "Opening prose.",
    images: [],
    warnings: [],
  };
  const contentDigest = await digest(
    JSON.stringify({
      title: draft.title,
      authorId: draft.authorId,
      markdown: draft.markdown,
      media: [],
    }),
  );
  if (options.modified) draft.markdown = "Modified prose.";
  await db
    .prepare(
      "INSERT INTO jobs(id,site,author,message_key,input_digest,digest,token_hash,state,draft,expires,created,updated) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(
      id,
      "ekselera",
      "writer@example.com",
      "message",
      "raw",
      contentDigest,
      await digest(token),
      options.state || "awaiting_confirmation",
      JSON.stringify(draft),
      Date.now() + (options.expired ? -1 : 86400000),
      Date.now(),
      Date.now(),
    )
    .run();
  return { mf, db };
}
test("email scanner GETs cannot publish; POST confirms once and creates one durable outbox entry", async () => {
  const { mf, db } = await fixture();
  try {
    const preview = await mf.dispatchFetch(
      `https://publishing.example.com/draft/${token}`,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("cache-control"), "no-store");
    assert.ok(
      preview.headers
        .get("content-security-policy")
        ?.includes("frame-ancestors 'none'"),
    );
    assert.equal(
      (await db.prepare("SELECT state FROM jobs").first())?.state,
      "awaiting_confirmation",
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://publishing.example.com/draft/${token}/publish`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://publishing.example.com/draft/${token}/publish`,
          {
            method: "POST",
            body: "",
            headers: { origin: "https://attacker.example.com" },
          },
        )
      ).status,
      403,
    );
    for (let n = 0; n < 2; n++)
      assert.equal(
        (
          await mf.dispatchFetch(
            `https://publishing.example.com/draft/${token}/publish`,
            {
              method: "POST",
              body: "",
              redirect: "manual",
              headers: { origin: site.serviceOrigin },
            },
          )
        ).status,
        303,
      );
    assert.equal(
      (await db.prepare("SELECT state FROM jobs").first())?.state,
      "confirmed",
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM outbox").first())?.count,
      1,
    );
  } finally {
    await mf.dispose();
  }
});

test("signed webhook retries and later opt-in events never restore suppression", async () => {
  const { mf, db } = await fixture();
  async function send(eventId: string, event: unknown, valid = true) {
    const body = JSON.stringify(event),
      timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", Buffer.alloc(32, 7))
      .update(`${eventId}.${timestamp}.${body}`)
      .digest("base64");
    return mf.dispatchFetch("https://publishing.example.com/webhooks/resend", {
      method: "POST",
      body,
      headers: {
        "svix-id": eventId,
        "svix-timestamp": timestamp,
        "svix-signature": `v1,${valid ? signature : "invalid"}`,
      },
    });
  }
  try {
    const optOut = {
      type: "contact.updated",
      created_at: new Date().toISOString(),
      data: { email: "reader@example.com", unsubscribed: true },
    };
    assert.equal((await send("forged", optOut, false)).status, 400);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM suppressions").first())
        ?.count,
      0,
    );
    assert.equal((await send("event-1", optOut)).status, 200);
    assert.equal((await send("event-1", optOut)).status, 200);
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM events").first())?.count,
      1,
    );
    assert.equal(
      (
        await send("event-2", {
          type: "contact.topics.updated",
          created_at: new Date().toISOString(),
          data: {
            email: "reader@example.com",
            topics: [{ id: "topic", subscription: "opt_in" }],
          },
        })
      ).status,
      200,
    );
    assert.equal(
      (await db.prepare("SELECT COUNT(*) AS count FROM suppressions").first())
        ?.count,
      1,
    );
  } finally {
    await mf.dispose();
  }
});
for (const options of [
  { expired: true },
  { modified: true },
  { state: "discarded" },
  { state: "inviting" },
  { state: "failed" },
])
  test(`invalid invitation ${JSON.stringify(options)} fails`, async () => {
    const { mf } = await fixture(true, options);
    try {
      assert.equal(
        (
          await mf.dispatchFetch(
            `https://publishing.example.com/draft/${token}`,
          )
        ).status,
        404,
      );
    } finally {
      await mf.dispose();
    }
  });
test("revoked author and unknown host cannot authorize a draft", async () => {
  const { mf } = await fixture(false);
  try {
    assert.equal(
      (await mf.dispatchFetch(`https://publishing.example.com/draft/${token}`))
        .status,
      404,
    );
    assert.equal(
      (await mf.dispatchFetch(`https://other.example.com/draft/${token}`))
        .status,
      421,
    );
  } finally {
    await mf.dispose();
  }
});
test("Discard is atomic and permanently invalidates the invitation", async () => {
  const { mf, db } = await fixture();
  try {
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://publishing.example.com/draft/${token}/discard`,
          {
            method: "POST",
            body: "",
            redirect: "manual",
            headers: { origin: site.serviceOrigin },
          },
        )
      ).status,
      303,
    );
    assert.equal(
      (await db.prepare("SELECT state FROM jobs").first())?.state,
      "discarded",
    );
    assert.equal(
      (
        await mf.dispatchFetch(
          `https://publishing.example.com/draft/${token}/publish`,
          { method: "POST", body: "", headers: { origin: site.serviceOrigin } },
        )
      ).status,
      404,
    );
  } finally {
    await mf.dispose();
  }
});
test("subscription confirmation GET leaves consent pending and repeated confirmed POST cannot reenroll", async () => {
  const { mf, db } = await fixture();
  try {
    await db
      .prepare(
        "INSERT INTO subscriptions(id,site,email,token_hash,expires,consent_version,created) VALUES (?,?,?,?,?,?,?)",
      )
      .bind(
        "subscription",
        "ekselera",
        "reader@example.com",
        await digest(token),
        Date.now() + 86400000,
        "v1",
        Date.now(),
      )
      .run();
    const response = await mf.dispatchFetch(
      `https://publishing.example.com/subscriptions/${token}`,
    );
    assert.equal(response.status, 200);
    assert.equal(
      (await db.prepare("SELECT state FROM subscriptions").first())?.state,
      "pending",
    );
    await db.prepare("UPDATE subscriptions SET state='confirmed'").run();
    const duplicate = await mf.dispatchFetch(
      `https://publishing.example.com/subscriptions/${token}`,
      { method: "POST", body: "", headers: { origin: site.serviceOrigin } },
    );
    assert.equal(duplicate.status, 200);
    assert.ok((await duplicate.text()).includes("already processed"));
  } finally {
    await mf.dispose();
  }
});

test("retention cleanup advances beyond its first batch and preserves the publication ledger", async () => {
  const { mf, db } = await fixture();
  try {
    const bucket = await mf.getR2Bucket("DRAFTS");
    const old = Date.now() - 8 * 86400000;
    for (let n = 0; n < 60; n++) {
      const jobId = `expired-${n}`;
      await db
        .prepare(
          "INSERT INTO jobs(id,site,author,message_key,input_digest,digest,token_hash,state,draft,expires,created,updated) VALUES (?,?,?,?,?,?,?,'expired',?,?,?,?)",
        )
        .bind(
          jobId,
          "ekselera",
          "writer@example.com",
          jobId,
          "input",
          "digest",
          jobId,
          JSON.stringify({ markdown: "Private old draft", images: [] }),
          old,
          old,
          old,
        )
        .run();
      await bucket.put(`${jobId}/image.png`, "private attachment");
    }
    const worker = await mf.getWorker();
    await worker.scheduled();
    assert.equal(
      (
        await db
          .prepare(
            "SELECT COUNT(*) AS count FROM jobs WHERE cleaned_at IS NOT NULL",
          )
          .first()
      ).count,
      50,
    );
    await worker.scheduled();
    const result = await db
      .prepare("SELECT id,draft,cleaned_at FROM jobs WHERE state='expired'")
      .all();
    assert.equal(result.results.length, 60);
    assert.ok(
      result.results.every(
        (row) => row.cleaned_at && JSON.parse(row.draft).markdown === "",
      ),
    );
    assert.equal((await bucket.list()).objects.length, 0);
  } finally {
    await mf.dispose();
  }
});
