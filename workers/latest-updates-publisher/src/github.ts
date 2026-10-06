import { createAppAuth } from "@octokit/auth-app";
import type { Site } from "./config";
import { publishedFile } from "./content";
import { draftOf, updateJob, type Job } from "./store";
import { digest } from "./security";

export async function github(
  env: RuntimeEnv,
  site: Site,
  path: string,
  method = "GET",
  body?: unknown,
) {
  const auth = createAppAuth({
    appId: env.GITHUB_APP_ID,
    privateKey: env.GITHUB_APP_PRIVATE_KEY,
    installationId: site.installationId,
  });
  const { token } = await auth({ type: "installation" });
  const response = await fetch(
    `https://api.github.com/repos/${site.repository}/${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "latest-updates-publisher",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    },
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.status === 204 ? {} : (response.json() as Promise<any>);
}
function base64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}
export async function expectedFiles(env: RuntimeEnv, site: Site, job: Job) {
  const draft = draftOf(job);
  const files = [
    {
      path: `${site.contentPrefix}${draft.slug}.md`,
      bytes: new TextEncoder().encode(
        publishedFile(draft, job.published_at!, job.digest),
      ),
    },
  ];
  for (const image of draft.images) {
    const object = await env.DRAFTS.get(image.key);
    if (!object) throw new Error("draft_media_missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await digest(bytes)) !== image.digest)
      throw new Error("draft_media_modified");
    files.push({ path: `${site.mediaPrefix}${job.id}/${image.name}`, bytes });
  }
  return files;
}
export async function openPublication(env: RuntimeEnv, site: Site, job: Job) {
  const branch = `feat/${site.trackingIssue}-publish-${job.id}`;
  await updateJob(env, job.id, { state: "opening_pr", branch });
  let ref = await github(env, site, `git/ref/heads/${branch}`);
  const base = await github(env, site, `git/ref/heads/${site.branch}`);
  if (!base) throw new Error("base_missing");
  if (!ref) {
    // Ref creation is the last write, so retries cannot create duplicate commits/PRs.
    const commit = await github(env, site, `git/commits/${base.object.sha}`);
    const files = await expectedFiles(env, site, job);
    const tree = [];
    for (const file of files) {
      const blob = await github(env, site, "git/blobs", "POST", {
        content: base64(file.bytes),
        encoding: "base64",
      });
      tree.push({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: blob.sha,
      });
    }
    const newTree = await github(env, site, "git/trees", "POST", {
      base_tree: commit.tree.sha,
      tree,
    });
    const newCommit = await github(env, site, "git/commits", "POST", {
      message: `docs(latest-updates): ${draftOf(job).title}`,
      tree: newTree.sha,
      parents: [base.object.sha],
    });
    await github(env, site, "git/refs", "POST", {
      ref: `refs/heads/${branch}`,
      sha: newCommit.sha,
    });
    ref = { object: { sha: newCommit.sha } };
  }
  const prs = await github(
    env,
    site,
    `pulls?state=all&head=${site.repository.split("/")[0]}:${branch}`,
  );
  let pr = prs?.[0];
  if (!pr)
    pr = await github(env, site, "pulls", "POST", {
      title: `docs(latest-updates): ${draftOf(job).title}`,
      body: `Publish Latest Updates post ${job.id}.\n\nContent digest: ${job.digest}\n\nTracking: #${site.trackingIssue}`,
      head: branch,
      base: site.branch,
    });
  await updateJob(env, job.id, {
    pr: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
    state: pr.merged ? "needs_attention" : "validating",
    merged_sha: pr.merge_commit_sha,
  });
}
export async function inspectPublication(
  env: RuntimeEnv,
  site: Site,
  job: Job,
) {
  if (!job.pr) return;
  const pr = await github(env, site, `pulls/${job.pr}`);
  if (pr?.merged) {
    if (job.state !== "merging" || pr.head.sha !== job.head)
      throw new Error("unexpected_external_merge");
    await updateJob(env, job.id, {
      state: "deploying",
      merged_sha: pr.merge_commit_sha,
    });
    return;
  }
  if (
    !pr ||
    pr.state !== "open" ||
    pr.head.ref !== job.branch ||
    pr.base.ref !== site.branch ||
    pr.head.repo.full_name !== site.repository
  )
    throw new Error("unexpected_pr");
  const files: any[] = [];
  for (let page = 1; page <= 31; page++) {
    const batch = await github(
      env,
      site,
      `pulls/${job.pr}/files?per_page=100&page=${page}`,
    );
    files.push(...batch);
    if (batch.length < 100) break;
    if (page === 31) throw new Error("too_many_pr_files");
  }
  const expected = await expectedFiles(env, site, job);
  if (
    files.length !== expected.length ||
    files.some(
      (f) =>
        f.status !== "added" || !expected.some((e) => e.path === f.filename),
    )
  )
    throw new Error("unexpected_pr_paths");
  for (const file of expected) {
    const object = await github(
      env,
      site,
      `contents/${file.path}?ref=${pr.head.sha}`,
    );
    if (!object || object.type !== "file")
      throw new Error("unexpected_pr_content");
    const blob = await github(env, site, `git/blobs/${object.sha}`);
    if (
      !blob?.content ||
      (await digest(new Uint8Array(Buffer.from(blob.content, "base64")))) !==
        (await digest(file.bytes))
    )
      throw new Error("unexpected_pr_content");
  }
  const base = await github(env, site, `git/ref/heads/${site.branch}`);
  const comparison = await github(
    env,
    site,
    `compare/${base.object.sha}...${pr.head.sha}`,
  );
  if (!["ahead", "identical"].includes(comparison?.status)) {
    await github(env, site, `pulls/${job.pr}/update-branch`, "PUT", {
      expected_head_sha: pr.head.sha,
    });
    await updateJob(env, job.id, {
      state: "validating",
      head: pr.head.sha,
      base: base.object.sha,
    });
    return;
  }
  const runs = await github(
    env,
    site,
    `actions/workflows/latest-updates-check.yml/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`,
  );
  const latestRun = runs?.workflow_runs
    ?.filter((r: any) => r.head_sha === pr.head.sha)
    .sort((a: any, b: any) => b.id - a.id)[0];
  if (latestRun?.status === "completed" && latestRun.conclusion !== "success")
    throw new Error("validation_failed");
  const run =
    latestRun?.status === "completed" && latestRun.conclusion === "success"
      ? latestRun
      : undefined;
  if (!run) {
    await updateJob(env, job.id, {
      state: "validating",
      head: pr.head.sha,
      base: base.object.sha,
    });
    return;
  }
  // Verify the validation job used exactly the current base, not an earlier PR merge base.
  const checkArtifact = await github(
    env,
    site,
    `actions/runs/${run.id}/artifacts`,
  );
  const marker = checkArtifact?.artifacts?.find(
    (a: any) =>
      a.name === `updates-tested-${pr.head.sha}-${base.object.sha}` &&
      !a.expired,
  );
  if (!marker) return;
  const latest = await github(env, site, `pulls/${job.pr}`);
  const latestBase = await github(env, site, `git/ref/heads/${site.branch}`);
  if (
    latest.head.sha !== pr.head.sha ||
    latestBase.object.sha !== base.object.sha
  )
    return;
  await updateJob(env, job.id, {
    state: "merging",
    head: pr.head.sha,
    base: base.object.sha,
  });
  const merged = await github(env, site, `pulls/${job.pr}/merge`, "PUT", {
    merge_method: "squash",
    sha: pr.head.sha,
    commit_title: `docs(latest-updates): ${draftOf(job).title}`,
  });
  if (!merged?.merged) throw new Error("merge_not_completed");
  await updateJob(env, job.id, { state: "deploying", merged_sha: merged.sha });
  // An App-authenticated merge emits the push event consumed by the serialized deployment workflow.
}
