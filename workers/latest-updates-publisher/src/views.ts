import {
  processMarkdown,
  escapeHtml as e,
  dateLabel,
} from "../../../src/features/latest-updates/markdown";
import { draftOf, type Job } from "./store";
import type { Site } from "./config";
import styles from "../../../src/features/latest-updates/updates.css";

export function page(site: Site, title: string, body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${e(title)} | ${e(site.name)}</title><style>${styles}\n@font-face{font-family:'DM Sans';src:url('/fonts/dm-sans-latin-wght-normal.woff2')}@font-face{font-family:'JetBrains Mono';src:url('/fonts/jetbrains-mono-latin-wght-normal.woff2')}body{margin:0;background:${site.background};font-family:'DM Sans',sans-serif}.latest-updates{padding-top:48px}button{font:inherit;border:1px solid #1c1b19;border-radius:10px;padding:12px 20px;cursor:pointer;background:${site.accent};color:${site.id === "ekselera" ? "#fff" : "#1c1b19"}}form{display:inline-block;margin:12px 12px 12px 0}</style></head><body><main class="latest-updates" data-brand="${e(site.id)}"><p>${e(site.name)} · private publishing</p>${body}</main></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex,nofollow",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
export async function preview(site: Site, job: Job, token: string) {
  const draft = draftOf(job);
  const media = draft.images.map((image) => ({
    ...image,
    name: image.url,
    url: `/draft/${token}/media/${encodeURIComponent(image.name)}`,
  }));
  const article = await processMarkdown(draft.markdown, media);
  const actions =
    job.state === "awaiting_confirmation"
      ? `<form method="post" action="/draft/${token}/publish"><button>Publish to ${e(site.name)}</button></form><form method="post" action="/draft/${token}/discard"><button>Discard draft</button></form>`
      : `<p>Publication status: ${e(job.state)}</p>`;
  return page(
    site,
    draft.title,
    `<h1>${e(draft.title)}</h1><p class="updates-meta">${e(draft.authorName)} · ${dateLabel(job.published_at || new Date())}</p><p><strong>Destination: ${e(site.name)}</strong></p><p>Summary: ${e(draft.summary)}</p>${draft.warnings.map((w) => `<p>${e(w)}</p>`).join("")}<article class="updates-prose">${article.html}</article>${actions}<p>Invitations expire after 24 hours. Publication time is set when you press Publish.</p>`,
  );
}
