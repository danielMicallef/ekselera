import test from "node:test";
import assert from "node:assert/strict";
import {
  parseIncoming,
  inspectImage,
  filename,
  publishedFile,
} from "../src/content";
import { digest, signedCallback } from "../src/security";
import { authorFor, sites } from "../src/config";
const site = { id: "ekselera", recipient: "post@publish.ekselera.com" } as any;
const env = {
  AUTHORS_JSON: JSON.stringify([
    {
      id: "writer",
      email: "writer@example.com",
      name: "Writer",
      sites: ["ekselera"],
    },
  ]),
} as any;
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR9sAAAAASUVORK5CYII=",
  "base64",
);
function email(
  options: {
    from?: string;
    to?: string;
    extra?: string;
    body?: string;
    filename?: string;
    image?: boolean;
  } = {},
) {
  const lines = [
    `From: ${options.from || "Writer <writer@example.com>"}`,
    `To: ${options.to || site.recipient}`,
    "Subject: Café updates",
    "Message-ID: <unique@example.com>",
    options.extra || "",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="boundary"',
    "",
    "--boundary",
    "Content-Type: text/plain",
    "",
    "Ignore this signature.",
    "--boundary",
    `Content-Type: text/markdown; charset=utf-8`,
    `Content-Disposition: attachment; filename="${options.filename || "update.md"}"`,
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(options.body || "Opening prose.").toString("base64"),
  ];
  if (options.image)
    lines.push(
      "--boundary",
      "Content-Type: image/png",
      'Content-Disposition: attachment; filename="workflow.png"',
      "Content-Transfer-Encoding: base64",
      "",
      png.toString("base64"),
    );
  lines.push("--boundary--");
  return new TextEncoder().encode(
    lines.filter((line, i) => line !== "" || i > 5).join("\r\n"),
  ).buffer;
}
const envelope = { from: "writer@example.com", to: site.recipient };
test("valid direct email supplies title/body and safe generated frontmatter", async () => {
  const parsed = await parseIncoming(
    email({
      body: "Opening prose.\n\n![Invoice workflow](workflow.png)",
      image: true,
    }),
    envelope,
    site,
    env,
    crypto.randomUUID(),
  );
  assert.equal(parsed.draft.title, "Café updates");
  assert.equal(parsed.draft.images.length, 1);
  assert.equal(parsed.draft.authorId, "writer");
  const file = publishedFile(
    parsed.draft,
    "2026-10-06T00:00:00Z",
    parsed.contentDigest,
  );
  assert.ok(!file.includes("writer@example.com"));
  assert.ok(file.includes("postId:"));
  assert.ok(!file.includes("signature"));
});
test("unauthorized, forged-envelope, ambiguous and wrong destination messages fail", async () => {
  await assert.rejects(
    parseIncoming(
      email(),
      { ...envelope, from: "attacker@example.com" },
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ from: "attacker@example.com" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ from: "writer@example.com, other@example.com" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ extra: "From: writer@example.com" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ to: "post@publish.ziffa.io" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ extra: "Cc: post@publish.ziffa.io" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ extra: "Bcc: post@publish.ziffa.io" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ extra: "Resent-From: writer@example.com" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
});
test("sender-supplied Reply-To and Authentication-Results do not grant authorization", async () => {
  await assert.rejects(
    parseIncoming(
      email({
        from: "attacker@example.com",
        extra:
          "Reply-To: writer@example.com\r\nAuthentication-Results: dmarc=pass",
      }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
});
test("removed author no longer resolves for confirmation", () => {
  assert.ok(authorFor(env, site, envelope.from));
  assert.equal(
    authorFor({ ...env, AUTHORS_JSON: "[]" }, site, envelope.from),
    undefined,
  );
});
test("unsupported Markdown attachments and oversized bodies fail", async () => {
  await assert.rejects(
    parseIncoming(
      email({ filename: "update.mdx" }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      email({ body: "a".repeat(128 * 1024 + 1) }),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
  await assert.rejects(
    parseIncoming(
      new ArrayBuffer(10 * 1024 * 1024 + 1),
      envelope,
      site,
      env,
      crypto.randomUUID(),
    ),
  );
});
test("sniffs images and rejects mismatched types/traversal", () => {
  assert.deepEqual(inspectImage("workflow.png", png), {
    width: 1,
    height: 1,
    type: "image/png",
  });
  assert.throws(() => inspectImage("workflow.jpg", png));
  assert.throws(() => filename("../workflow.png"));
  assert.throws(() => inspectImage("workflow.svg", png));
  assert.throws(() =>
    inspectImage("workflow.png", new Uint8Array(2 * 1024 * 1024 + 1)),
  );
});
test("staging rejects production branches and origins", () => {
  assert.throws(() =>
    sites({
      SITES_JSON: JSON.stringify([
        {
          ...site,
          serviceOrigin: "https://staging.example.com",
          contentPrefix: "src/content/updates/",
          mediaPrefix: "public/media/",
          branch: "main",
          origin: "https://staging.example.com",
        },
      ]),
      ENVIRONMENT: "staging",
    } as any),
  );
});
test("callback authenticates body and expires old signatures", async () => {
  const timestamp = String(Math.floor(Date.now() / 1000)),
    body = '{"eventId":"test"}',
    secret = "test-only-secret";
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${body}`),
    ),
  ).toString("hex");
  const request = new Request("https://example.com", {
    headers: {
      "x-publishing-timestamp": timestamp,
      "x-publishing-signature": signature,
    },
  });
  assert.equal(await signedCallback(request, secret, body), true);
  assert.equal(await signedCallback(request, secret, body + "modified"), false);
  assert.equal(
    await signedCallback(
      new Request("https://example.com", {
        headers: {
          "x-publishing-timestamp": "1",
          "x-publishing-signature": signature,
        },
      }),
      secret,
      body,
    ),
    false,
  );
  assert.equal((await digest("content")).length, 64);
});
