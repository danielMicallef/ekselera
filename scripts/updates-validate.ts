import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "yaml";
import { processMarkdown } from "../src/features/latest-updates/markdown";
import { createHash } from "node:crypto";
import { imageSize } from "image-size";
import { updatesConfig } from "../src/config/latest-updates";
const root = process.cwd();
const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export async function validatePosts() {
  const directory = resolve(root, "src/content/updates");
  let names: string[] = [];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const posts: any[] = [],
    ids = new Set<string>(),
    slugs = new Set<string>();
  for (const name of names.filter((n) => n.endsWith(".md"))) {
    const source = await readFile(resolve(directory, name), "utf8");
    const match = source.match(
      /^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/,
    );
    if (!match) throw new Error(`Invalid generated frontmatter: ${name}`);
    const metadata = parse(match[1]);
    const body = match[2].replace(/\n$/, "");
    const allowed = [
      "postId",
      "slug",
      "title",
      "authorId",
      "publishedAt",
      "summary",
      "contentDigest",
      "media",
    ];
    if (
      Object.keys(metadata).some((key) => !allowed.includes(key)) ||
      !/^[a-f\d-]{36}$/.test(metadata.postId) ||
      typeof metadata.title !== "string" ||
      metadata.title.length > 180 ||
      typeof metadata.authorId !== "string" ||
      !/^[\p{L}\p{N}-]+$/u.test(metadata.slug) ||
      name !== `${metadata.slug}.md` ||
      !Number.isFinite(Date.parse(metadata.publishedAt)) ||
      !Array.isArray(metadata.media) ||
      metadata.media.length > 5
    )
      throw new Error(`Invalid metadata: ${name}`);
    if (!updatesConfig.authors[metadata.authorId])
      throw new Error(`Missing public author profile: ${metadata.authorId}`);
    if (ids.has(metadata.postId) || slugs.has(metadata.slug))
      throw new Error("Duplicate post ID or slug");
    ids.add(metadata.postId);
    slugs.add(metadata.slug);
    for (const image of metadata.media) {
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(image.name) ||
        image.name.includes("..") ||
        image.url !== `/latest-updates/media/${metadata.postId}/${image.name}`
      )
        throw new Error("Invalid image path");
      const bytes = await readFile(resolve(root, "public" + image.url));
      const size = imageSize(bytes);
      const expected = (
        { png: "png", jpg: "jpg", jpeg: "jpg", webp: "webp" } as Record<
          string,
          string
        >
      )[image.name.split(".").pop().toLowerCase()];
      if (
        bytes.length > 2 * 1024 * 1024 ||
        !expected ||
        size.type !== expected ||
        size.width !== image.width ||
        size.height !== image.height ||
        hash(bytes) !== image.digest
      )
        throw new Error(`Image does not match metadata: ${image.name}`);
    }
    const rendered = await processMarkdown(
      body,
      metadata.media.map((m: any) => ({ ...m, name: m.url })),
    );
    const digest = hash(
      JSON.stringify({
        title: metadata.title,
        authorId: metadata.authorId,
        markdown: body,
        media: metadata.media.map(({ name, digest }: any) => ({
          name,
          digest,
        })),
      }),
    );
    if (
      digest !== metadata.contentDigest ||
      rendered.summary !== metadata.summary ||
      rendered.warnings.length
    )
      throw new Error(`Content digest/summary does not match: ${name}`);
    posts.push(metadata);
  }
  return posts;
}
if (process.argv.includes("--pr")) {
  const base = process.env.UPDATES_BASE_SHA,
    head = process.env.UPDATES_HEAD_SHA;
  if (!base || !head) throw new Error("Missing PR revisions");
  const prefix = process.env.UPDATES_SITE_PREFIX || "";
  const lines = execFileSync(
    "git",
    ["diff", "--name-status", `${base}...${head}`],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  let articleCount = 0;
  for (const line of lines) {
    const [status, path] = line.split("\t");
    if (
      status !== "A" ||
      !(
        (path.startsWith(`${prefix}src/content/updates/`) &&
          /^.+\.md$/.test(path)) ||
        (path.startsWith(`${prefix}public/latest-updates/media/`) &&
          /\.(png|jpe?g|webp)$/i.test(path))
      )
    )
      throw new Error(`Unexpected content PR change: ${line}`);
    if (path.startsWith(`${prefix}src/content/updates/`)) articleCount++;
  }
  if (articleCount !== 1)
    throw new Error("Publication PR must add exactly one article");
}
const posts = await validatePosts();
console.log(`Validated ${posts.length} Latest Updates articles.`);
