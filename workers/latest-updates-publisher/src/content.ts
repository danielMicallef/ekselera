import PostalMime from "postal-mime";
import { imageSize } from "image-size";
import {
  processMarkdown,
  slugFor,
} from "../../../src/features/latest-updates/markdown";
import { digest } from "./security";
import { authorFor, type Site } from "./config";
export interface Draft {
  id: string;
  slug: string;
  title: string;
  authorId: string;
  authorName: string;
  summary: string;
  markdown: string;
  images: {
    name: string;
    url: string;
    width: number;
    height: number;
    digest: string;
    key: string;
    type: string;
  }[];
  warnings: string[];
}
export function filename(name: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name) || name.includes(".."))
    throw new Error("Unsafe attachment filename");
  return name;
}
export function inspectImage(name: string, bytes: Uint8Array) {
  filename(name);
  if (bytes.length > 2 * 1024 * 1024) throw new Error("Image exceeds 2 MiB");
  const size = imageSize(bytes);
  const extension = name.split(".").pop()!.toLowerCase();
  if (
    !size.width ||
    !size.height ||
    !(
      { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" } as Record<
        string,
        string
      >
    )[extension] ||
    (
      { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" } as Record<
        string,
        string
      >
    )[extension] !== size.type
  )
    throw new Error(
      "Image extension and actual type must match PNG, JPEG, or WebP",
    );
  return {
    width: size.width,
    height: size.height,
    type: size.type === "jpg" ? "image/jpeg" : `image/${size.type}`,
  };
}
export async function parseIncoming(
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
  site: Site,
  env: RuntimeEnv,
  id: string,
) {
  if (raw.byteLength > 10 * 1024 * 1024)
    throw new Error("Message exceeds 10 MiB");
  const email = await PostalMime.parse(raw);
  const fromHeaders = email.headers.filter((h) => h.key === "from");
  const author =
    email.from?.address && authorFor(env, site, email.from.address);
  if (
    fromHeaders.length !== 1 ||
    !author ||
    email.from?.group ||
    envelope.from.toLowerCase() !== author.email.toLowerCase()
  )
    throw new Error("Sender is not authorized or envelope differs");
  // Reject multi-mailbox From even if a MIME parser returned the first mailbox.
  const { addressParser } = await import("postal-mime");
  const from = addressParser(fromHeaders[0].value, { flatten: true });
  if (
    from.length !== 1 ||
    from[0].address?.toLowerCase() !== author.email.toLowerCase()
  )
    throw new Error("Ambiguous From mailbox");
  const destinations = [...(email.to || []), ...(email.cc || [])];
  if (
    destinations.length !== 1 ||
    destinations[0].address?.toLowerCase() !== site.recipient.toLowerCase() ||
    envelope.to.toLowerCase() !== site.recipient.toLowerCase() ||
    email.headers.some((h) =>
      ["bcc", "resent-from", "resent-to"].includes(h.key),
    )
  )
    throw new Error(
      "Use exactly one visible publishing recipient, without forwarding or Bcc",
    );
  const title = email.subject?.trim();
  if (!title || title.length > 180 || /[\r\n\u0000-\u001f]/.test(title))
    throw new Error("Subject must supply a title of 1–180 characters");
  if (!email.messageId || email.messageId.length > 500)
    throw new Error("Message-ID is required");
  const attachments = email.attachments;
  const names = new Set<string>();
  for (const item of attachments) {
    filename(item.filename || "");
    const normalized = item.filename!.toLowerCase();
    if (names.has(normalized)) throw new Error("Duplicate attachment filename");
    names.add(normalized);
  }
  const md = attachments.filter((a) => /\.md$/i.test(a.filename!));
  const imageAttachments = attachments.filter(
    (a) => !/\.md$/i.test(a.filename!),
  );
  if (md.length !== 1) throw new Error("Attach exactly one UTF-8 .md file");
  if (imageAttachments.length > 5)
    throw new Error("Attach at most five images");
  const bytes = new Uint8Array(md[0].content as ArrayBuffer);
  if (bytes.byteLength > 128 * 1024)
    throw new Error("Markdown exceeds 128 KiB");
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const images = await Promise.all(
    imageAttachments.map(async (item) => {
      const name = item.filename!;
      const bytes = new Uint8Array(item.content as ArrayBuffer);
      const size = inspectImage(name, bytes);
      return {
        name,
        bytes,
        ...size,
        digest: await digest(bytes),
        key: `${id}/${name}`,
        url: `/latest-updates/media/${id}/${name}`,
      };
    }),
  );
  const rendered = await processMarkdown(source, images);
  const used = images.filter((i) => rendered.used.includes(i.name));
  const draft: Draft = {
    id,
    slug: slugFor(title, id),
    title,
    authorId: author.id,
    authorName: author.name,
    summary: rendered.summary,
    markdown: rendered.markdown,
    images: used.map(({ bytes, ...image }) => image),
    warnings: rendered.warnings,
  };
  const contentDigest = await digest(
    JSON.stringify({
      title,
      authorId: author.id,
      markdown: draft.markdown,
      media: draft.images.map(({ name, digest }) => ({ name, digest })),
    }),
  );
  return {
    draft,
    contentDigest,
    messageKey: await digest(
      `${site.id}:${author.email.toLowerCase()}:${email.messageId}`,
    ),
    images: used,
    email,
  };
}
export function publishedFile(
  draft: Draft,
  publishedAt: string,
  contentDigest: string,
) {
  const metadata = {
    postId: draft.id,
    slug: draft.slug,
    title: draft.title,
    authorId: draft.authorId,
    publishedAt,
    summary: draft.summary,
    contentDigest,
    media: draft.images.map(({ name, url, width, height, digest }) => ({
      name,
      url,
      width,
      height,
      digest,
    })),
  };
  // JSON scalars/arrays are valid YAML and cannot inject additional frontmatter.
  return `---\n${Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${draft.markdown}\n`;
}
