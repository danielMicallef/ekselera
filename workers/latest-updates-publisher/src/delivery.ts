import { resendClient } from "./resend";
import { draftOf, updateJob, type Job } from "./store";
import { type Site } from "./config";
import { escapeHtml as e } from "../../../src/features/latest-updates/markdown";
import { ensureTestRecipient } from "./config";

export async function verifyProduction(site: Site, job: Job) {
  const headers = { "Cache-Control": "no-cache" };
  const get = (path: string) =>
    fetch(
      `${site.origin}${path}${path.includes("?") ? "&" : "?"}verify=${crypto.randomUUID()}`,
      { headers, signal: AbortSignal.timeout(15000) },
    );
  const manifest = await get("/latest-updates-manifest.json");
  if (!manifest.ok) return false;
  const data = (await manifest.json()) as {
    posts: { postId: string; contentDigest: string; url: string }[];
  };
  const entry = data.posts.find(
    (p) => p.postId === job.id && p.contentDigest === job.digest,
  );
  if (!entry || entry.url !== `/latest-updates/${draftOf(job).slug}/`)
    return false;
  const article = await get(entry.url);
  if (!article.ok) return false;
  const html = await article.text();
  if (
    !html.includes(`data-post-id="${job.id}"`) ||
    !html.includes(`data-content-digest="${job.digest}"`)
  )
    return false;
  const home = await get("/");
  if (!home.ok || !(await home.text()).includes('href="/latest-updates/"'))
    return false;
  for (const image of draftOf(job).images) {
    const response = await get(image.url);
    const { digest } = await import("./security");
    if (
      !response.ok ||
      (await digest(new Uint8Array(await response.arrayBuffer()))) !==
        image.digest
    )
      return false;
  }
  return true;
}
export async function notifyLive(env: RuntimeEnv, site: Site, job: Job) {
  if (env.DELIVERY_PAUSED === "true") return;
  const resend = resendClient(env),
    draft = draftOf(job);
  const url = `${site.origin}/latest-updates/${draft.slug}/`;
  if (job.notification_state === "pending") {
    ensureTestRecipient(env, job.author);
    await updateJob(env, job.id, { notification_state: "sending" });
    try {
      const { error } = await resend.emails.send(
        {
          from: site.sender,
          to: job.author,
          subject: `Published on ${site.name}: ${draft.title}`,
          text: `Your article is live: ${url}`,
          html: `<h1>${e(site.name)}</h1><p>Your article is live: <a href="${e(url)}">${e(draft.title)}</a></p>`,
        },
        { idempotencyKey: `live-${job.id}` },
      );
      if (error) throw new Error("author_notification_failed");
      await updateJob(env, job.id, { notification_state: "author_sent" });
    } catch {
      await updateJob(env, job.id, { notification_state: "needs_attention" });
      return;
    }
  } else if (job.notification_state === "sending") {
    await updateJob(env, job.id, { notification_state: "needs_attention" });
    return;
  }
  if (["sent", "needs_attention"].includes(job.notification_state)) return;
  if (env.ENVIRONMENT === "staging") {
    await updateJob(env, job.id, { notification_state: "sent" });
    return;
  } // Never broadcast from staging.
  if (!job.broadcast_id && job.notification_state === "creating_broadcast") {
    // A crash may have followed provider acceptance before the ID was recorded.
    await updateJob(env, job.id, { notification_state: "needs_attention" });
    return;
  }
  if (!job.broadcast_id) {
    // An uncertain creation leaves an unsent draft and requires attention; it cannot send an unrecorded broadcast.
    await updateJob(env, job.id, { notification_state: "creating_broadcast" });
    try {
      const result = await resend.broadcasts.create({
        segmentId: site.segmentId,
        topicId: site.topicId,
        from: site.sender,
        subject: draft.title,
        name: `${site.id}:${job.id}`,
        previewText: draft.summary,
        html: `<h1>${e(site.name)} Latest Updates</h1><h2>${e(draft.title)}</h2><p>${e(draft.summary)}</p><p><a href="${e(url)}">Read the article</a></p><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe or manage preferences</a></p><p>${e(site.postalAddress)}</p>`,
        text: `${draft.title}\n\n${draft.summary}\n\n${url}\n\nUnsubscribe or manage preferences: {{{RESEND_UNSUBSCRIBE_URL}}}\n${site.postalAddress}`,
      });
      if (result.error) throw new Error("broadcast_creation_failed");
      await updateJob(env, job.id, {
        broadcast_id: result.data!.id,
        notification_state: "broadcast_draft",
      });
      job.broadcast_id = result.data!.id;
    } catch {
      await updateJob(env, job.id, { notification_state: "needs_attention" });
      return;
    }
  }
  const result = await resend.broadcasts.get(job.broadcast_id!);
  if (result.error) throw new Error("broadcast_lookup_failed");
  if (result.data!.status === "sent" || result.data!.status === "queued") {
    await updateJob(env, job.id, { notification_state: "sent" });
    return;
  }
  if (
    job.notification_state === "sending_broadcast" ||
    job.notification_state === "creating_broadcast"
  ) {
    await updateJob(env, job.id, { notification_state: "needs_attention" });
    return;
  }
  if (result.data!.status !== "draft") {
    await updateJob(env, job.id, { notification_state: "needs_attention" });
    return;
  }
  await updateJob(env, job.id, { notification_state: "sending_broadcast" });
  try {
    const sent = await resend.broadcasts.send(job.broadcast_id!);
    if (sent.error) throw new Error("broadcast_send_failed");
    await updateJob(env, job.id, { notification_state: "sent" });
  } catch {
    /* Keep uncertain state. Reconciler reads the recorded Broadcast before doing anything else. */
  }
}

export async function notifyFailure(env: RuntimeEnv, site: Site, job: Job) {
  if (env.DELIVERY_PAUSED === "true" || job.notification_state !== "pending")
    return;
  ensureTestRecipient(env, job.author);
  await updateJob(env, job.id, { notification_state: "sending_failure" });
  const draft = draftOf(job);
  try {
    const { error } = await resendClient(env).emails.send(
      {
        from: site.sender,
        to: job.author,
        subject: `${site.name} publication needs attention`,
        text: `Publication of “${draft.title}” has not completed.\nJob: ${job.id}\nStatus: ${job.state}\nPlease review the publishing ledger and recorded PR before retrying.`,
        html: `<h1>${e(site.name)}</h1><p>Publication of ${e(draft.title)} needs attention.</p><p>Job: ${e(job.id)}. Status: ${e(job.state)}.</p><p>Review the publishing ledger and recorded PR before retrying.</p>`,
      },
      { idempotencyKey: `failure-${job.id}` },
    );
    if (error) throw new Error("failure_notification_failed");
    await updateJob(env, job.id, { notification_state: "failure_sent" });
  } catch {
    await updateJob(env, job.id, { notification_state: "needs_attention" });
  }
}
