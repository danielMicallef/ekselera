import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { visit } from "unist-util-visit";
import type { Root, Image, ImageReference, Definition } from "mdast";

export interface Media {
  name: string;
  url: string;
  width: number;
  height: number;
}
export const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const dateLabel = (date: Date | string) =>
  new Intl.DateTimeFormat("en-MT", {
    timeZone: "Europe/Malta",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(date));
export function slugFor(title: string, id: string) {
  return `${
    title
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "update"
  }-${id.slice(0, 8)}`;
}
export function safeLink(url: string) {
  if (/[\u0000-\u0020\\]/u.test(url) || url.startsWith("//"))
    throw new Error("Unsafe link URL");
  if (/^[a-z][a-z\d+.-]*:/i.test(url) && !/^(https?:|mailto:)/i.test(url))
    throw new Error("Unsafe link URL");
  return url;
}
export async function processMarkdown(source: string, media: Media[]) {
  if (new TextEncoder().encode(source).length > 128 * 1024)
    throw new Error("Markdown exceeds 128 KiB");
  if (/^\s*(---|\+\+\+)\s*\r?\n/.test(source))
    throw new Error("Author frontmatter is unsupported");
  const parser = unified().use(remarkParse).use(remarkGfm);
  const tree = parser.parse(source) as Root;
  const definitions = new Map<string, Definition>();
  visit(tree, "definition", (node) => {
    if (definitions.has(node.identifier))
      throw new Error("Ambiguous reference definition");
    definitions.set(node.identifier, node);
  });
  const used = new Set<string>();
  const images = new Map(media.map((item) => [item.name, item]));
  if (images.size !== media.length)
    throw new Error("Duplicate attachment filename");
  visit(tree, (node, index, parent) => {
    if (node.type === "html") throw new Error("Raw HTML is unsupported");
    if (node.type === "link" || node.type === "definition") safeLink(node.url);
    if (node.type === "image" || node.type === "imageReference") {
      const original = node as Image | ImageReference;
      const url =
        original.type === "image"
          ? original.url
          : definitions.get(original.identifier)?.url;
      const item = url && images.get(url);
      if (!item)
        throw new Error("Image must reference an attached image by filename");
      if (!original.alt?.trim() || original.alt.trim().length < 3)
        throw new Error("Image requires descriptive alt text");
      used.add(item.name);
      const replacement: Image = {
        type: "image",
        url: item.url,
        alt: original.alt,
        data: {
          hProperties: {
            width: item.width,
            height: item.height,
            loading: "lazy",
            decoding: "async",
          },
        },
      };
      if (parent && index !== undefined) parent.children[index] = replacement;
    }
  });
  if (!tree.children.length) throw new Error("Article is empty");
  const text = (node: any): string =>
    node.type === "text" || node.type === "inlineCode"
      ? node.value
      : (node.children || []).map(text).join("");
  const opening = (
    tree.children
      .filter((n) => n.type === "paragraph")
      .map(text)
      .find((value) => value.trim()) || ""
  )
    .replace(/\s+/g, " ")
    .trim();
  if (!opening) throw new Error("Article needs opening prose for its summary");
  const summary =
    opening.length > 240
      ? opening
          .slice(0, 241)
          .replace(/\s+\S*$/, "")
          .slice(0, 240)
      : opening;
  const compiler = unified().use(remarkRehype).use(rehypeStringify);
  const html = compiler.stringify(await compiler.run(tree));
  // Rewrite image nodes by source position, leaving all other author Markdown untouched.
  const edits: { start: number; end: number; value: string }[] = [];
  const originalTree = parser.parse(source) as Root;
  visit(originalTree, (node) => {
    if (node.type !== "image" && node.type !== "imageReference") return;
    const name =
      node.type === "image" ? node.url : definitions.get(node.identifier)?.url;
    const image = name && images.get(name);
    if (image && node.position)
      edits.push({
        start: node.position.start.offset!,
        end: node.position.end.offset!,
        value: `![${(node.alt || "").replace(/\]/g, "\\]")}](${image.url})`,
      });
  });
  let markdown = source;
  for (const edit of edits.sort((a, b) => b.start - a.start))
    markdown =
      markdown.slice(0, edit.start) + edit.value + markdown.slice(edit.end);
  return {
    html,
    markdown,
    summary,
    used: [...used],
    warnings: media
      .filter((m) => !used.has(m.name))
      .map((m) => `Unused image excluded: ${m.name}`),
  };
}
