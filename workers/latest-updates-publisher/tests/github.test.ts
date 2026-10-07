import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { inspectPublication } from "../src/github";
import { publishedFile } from "../src/content";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const site = {
  repository: "owner/site",
  branch: "main",
  installationId: 7,
  contentPrefix: "src/content/updates/",
  mediaPrefix: "public/latest-updates/media/",
} as any;
function fixture(
  options: {
    extraPath?: boolean;
    changedBody?: boolean;
    behind?: boolean;
    failed?: boolean;
    staleArtifact?: boolean;
    merged?: boolean;
    mergeTimeout?: boolean;
  } = {},
) {
  const draft = {
    id: "post-id",
    slug: "title-post-id",
    title: "Title",
    authorId: "writer",
    summary: "Opening prose.",
    markdown: "Opening prose.",
    images: [],
    warnings: [],
  };
  const job = {
    id: "post-id",
    pr: 10,
    branch: "feat/2-publish-post-id",
    head: "head",
    base: "base",
    state: "validating",
    digest: "digest",
    draft: JSON.stringify(draft),
    published_at: "2026-10-06T10:00:00Z",
  } as any;
  const env = {
    GITHUB_APP_ID: "4242",
    GITHUB_APP_PRIVATE_KEY: privateKey.export({ type: "pkcs8", format: "pem" }),
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
  const writes: any[] = [];
  const fetch = async (input: any, init: any) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/access_tokens"))
      return Response.json({
        token: "test-installation-token",
        expires_at: new Date(Date.now() + 3600000).toISOString(),
        permissions: { contents: "write" },
        repository_selection: "selected",
      });
    if (init?.method !== "GET")
      writes.push({ path, body: init?.body && JSON.parse(init.body) });
    if (path.endsWith("/pulls/10/merge")) {
      if (options.mergeTimeout) throw new Error("merge_timeout");
      return Response.json({ merged: true, sha: "merged" });
    }
    if (path.endsWith("/pulls/10/update-branch"))
      return Response.json({ message: "updating" });
    if (path.endsWith("/pulls/10"))
      return Response.json({
        state: "open",
        merged: !!options.merged,
        merge_commit_sha: "merged",
        head: {
          sha: "head",
          ref: job.branch,
          repo: { full_name: site.repository },
        },
        base: { ref: "main", sha: "base" },
      });
    if (path.endsWith("/pulls/10/files"))
      return Response.json([
        {
          filename: options.extraPath
            ? ".github/workflows/hacked.yml"
            : `${site.contentPrefix}${draft.slug}.md`,
          status: "added",
        },
      ]);
    if (path.includes("/contents/"))
      return Response.json({ type: "file", sha: "blob" });
    if (path.endsWith("/git/blobs/blob"))
      return Response.json({
        content: Buffer.from(
          options.changedBody
            ? "changed"
            : publishedFile(draft as any, job.published_at, job.digest),
        ).toString("base64"),
      });
    if (path.endsWith("/git/ref/heads/main"))
      return Response.json({ object: { sha: "base" } });
    if (path.includes("/compare/"))
      return Response.json({ status: options.behind ? "diverged" : "ahead" });
    if (path.endsWith("/actions/workflows/latest-updates-check.yml/runs"))
      return Response.json({
        workflow_runs: [
          {
            id: 22,
            head_sha: "head",
            status: "completed",
            conclusion: options.failed ? "failure" : "success",
          },
        ],
      });
    if (path.endsWith("/actions/runs/22/artifacts"))
      return Response.json({
        artifacts: [
          {
            name: options.staleArtifact
              ? "updates-tested-oldhead-base"
              : "updates-tested-head-base",
            expired: false,
          },
        ],
      });
    throw new Error(`Unexpected GitHub call: ${path}`);
  };
  return { job, env, writes, fetch };
}
test("validated content merges only the expected tested head", async () => {
  const { job, env, writes, fetch } = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await inspectPublication(env, site, job);
    assert.equal(job.state, "deploying");
    assert.equal(writes.at(-1).body.sha, "head");
    assert.equal(writes.at(-1).body.merge_method, "squash");
  } finally {
    globalThis.fetch = original;
  }
});
for (const options of [
  { extraPath: true },
  { changedBody: true },
  { failed: true },
  { merged: true },
])
  test(`unexpected PR state cannot merge ${JSON.stringify(options)}`, async () => {
    const { job, env, writes, fetch } = fixture(options);
    const original = globalThis.fetch;
    globalThis.fetch = fetch;
    try {
      await assert.rejects(inspectPublication(env, site, job));
      assert.ok(!writes.some((w) => w.path.endsWith("/merge")));
    } finally {
      globalThis.fetch = original;
    }
  });
test("base changes update branch and require validation again", async () => {
  const { job, env, writes, fetch } = fixture({ behind: true });
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await inspectPublication(env, site, job);
    assert.equal(job.state, "validating");
    assert.ok(writes.some((w) => w.path.endsWith("/update-branch")));
    assert.ok(!writes.some((w) => w.path.endsWith("/merge")));
  } finally {
    globalThis.fetch = original;
  }
});
test("stale validation artifact cannot authorize merge", async () => {
  const { job, env, writes, fetch } = fixture({ staleArtifact: true });
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await inspectPublication(env, site, job);
    assert.ok(!writes.some((w) => w.path.endsWith("/merge")));
  } finally {
    globalThis.fetch = original;
  }
});
test("merge timeout is recovered by reading merged PR rather than repeating the write", async () => {
  const { job, env, writes, fetch } = fixture({ mergeTimeout: true });
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    await assert.rejects(inspectPublication(env, site, job));
    assert.equal(job.state, "merging");
    const recovered = fixture({ merged: true });
    recovered.job.state = "merging";
    globalThis.fetch = recovered.fetch;
    await inspectPublication(recovered.env, site, recovered.job);
    assert.equal(recovered.job.state, "deploying");
    assert.equal(recovered.writes.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
