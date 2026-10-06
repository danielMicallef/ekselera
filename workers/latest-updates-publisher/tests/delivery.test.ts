import test from "node:test";
import assert from "node:assert/strict";
import { notifyLive, verifyProduction } from "../src/delivery";
const site = {
  id: "ekselera",
  name: "Ekselera",
  origin: "https://site.example.com",
  postalAddress: "Test-only postal address",
  sender: "Newsletter <newsletter@example.com>",
  segmentId: "segment",
  topicId: "topic",
} as any;
function fixture(state = "author_sent", broadcastId: string | null = null) {
  const job = {
    id: "post-id",
    author: "writer@example.com",
    digest: "content-digest",
    notification_state: state,
    broadcast_id: broadcastId,
    draft: JSON.stringify({
      id: "post-id",
      slug: "new-post",
      title: "New post",
      summary: "Opening prose.",
      images: [],
    }),
  } as any;
  const env = {
    ENVIRONMENT: "production",
    DELIVERY_PAUSED: "false",
    RESEND_API_KEY: "test-only",
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: any[]) {
            return {
              async run() {
                const fields = sql
                  .match(/SET (.+) WHERE/)![1]
                  .split(",")
                  .map((f) => f.split("=")[0]);
                fields.forEach((field, i) => (job[field] = args[i]));
              },
            };
          },
        };
      },
    },
  } as any;
  return { job, env };
}
test("Broadcast targets both Segment and Topic, records ID before send and never repeats a successful send", async () => {
  const { job, env } = fixture(),
    calls: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any, init: any) => {
    calls.push({
      url: String(input),
      method: init?.method,
      body: init?.body && JSON.parse(init.body),
    });
    if (String(input).endsWith("/send")) {
      assert.equal(job.broadcast_id, "broadcast");
      return Response.json({ id: "broadcast" });
    }
    if (init?.method === "POST") return Response.json({ id: "broadcast" });
    return Response.json({ id: "broadcast", status: "draft" });
  };
  try {
    await notifyLive(env, site, job);
    const create = calls.find(
      (c) => c.method === "POST" && !c.url.endsWith("/send"),
    );
    assert.equal(create.body.segment_id, "segment");
    assert.equal(create.body.topic_id, "topic");
    assert.ok(create.body.html.includes("RESEND_UNSUBSCRIBE_URL"));
    assert.equal(job.notification_state, "sent");
    const count = calls.length;
    await notifyLive(env, site, job);
    assert.equal(calls.length, count);
  } finally {
    globalThis.fetch = original;
  }
});
test("uncertain Broadcast send is reconciled by persisted ID, not sent again", async () => {
  const { job, env } = fixture("broadcast_draft", "broadcast"),
    calls: string[] = [];
  const original = globalThis.fetch;
  let sent = false;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/send")) {
      sent = true;
      throw new Error("timeout after provider accepted");
    }
    return Response.json({
      id: "broadcast",
      status: sent ? "queued" : "draft",
    });
  };
  try {
    await notifyLive(env, site, job);
    assert.equal(job.notification_state, "sending_broadcast");
    await notifyLive(env, site, job);
    assert.equal(job.notification_state, "sent");
    assert.equal(calls.filter((c) => c.endsWith("/send")).length, 1);
  } finally {
    globalThis.fetch = original;
  }
});
test("ambiguous draft/send states stop for attention instead of another broadcast", async () => {
  const { job, env } = fixture("sending_broadcast", "broadcast");
  const original = globalThis.fetch;
  let sends = 0;
  globalThis.fetch = async (input: any) => {
    if (String(input).endsWith("/send")) sends++;
    return Response.json({ id: "broadcast", status: "draft" });
  };
  try {
    await notifyLive(env, site, job);
    assert.equal(job.notification_state, "needs_attention");
    assert.equal(sends, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("paused delivery leaves live posts and send ledger unchanged", async () => {
  const { job, env } = fixture();
  env.DELIVERY_PAUSED = "true";
  await notifyLive(env, site, job);
  assert.equal(job.notification_state, "author_sent");
  assert.equal(job.broadcast_id, null);
});
test("staging does not broadcast to production subscribers", async () => {
  const { job, env } = fixture();
  env.ENVIRONMENT = "staging";
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("must not call provider");
  };
  try {
    await notifyLive(env, site, job);
    assert.equal(job.notification_state, "sent");
  } finally {
    globalThis.fetch = original;
  }
});
test("manifest alone or an SPA fallback cannot prove live publication", async () => {
  const { job } = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async (input: any) => {
    const url = String(input);
    if (url.includes("manifest"))
      return Response.json({
        posts: [
          {
            postId: job.id,
            contentDigest: job.digest,
            url: "/latest-updates/new-post/",
          },
        ],
      });
    return new Response('<a href="/latest-updates/">Latest Updates</a>');
  };
  try {
    assert.equal(await verifyProduction(site, job), false);
    globalThis.fetch = async (input: any) =>
      String(input).includes("manifest")
        ? Response.json({
            posts: [
              {
                postId: job.id,
                contentDigest: job.digest,
                url: "/latest-updates/new-post/",
              },
            ],
          })
        : new Response(
            `<article data-post-id="${job.id}" data-content-digest="${job.digest}"></article><a href="/latest-updates/">Latest Updates</a>`,
          );
    assert.equal(await verifyProduction(site, job), true);
  } finally {
    globalThis.fetch = original;
  }
});

test("crash during Broadcast creation cannot create a second unrecorded draft", async () => {
  const { job, env } = fixture("creating_broadcast");
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    throw new Error("must reconcile first");
  };
  try {
    await notifyLive(env, site, job);
    assert.equal(job.notification_state, "needs_attention");
    assert.equal(job.broadcast_id, null);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = original;
  }
});
