import { readFileSync, writeFileSync } from "node:fs";
import { parse } from "yaml";
import { createHash } from "node:crypto";
import { processMarkdown } from "../src/features/latest-updates/markdown";
const path = process.argv[2];
if (!path) throw new Error("Pass the existing article Markdown path");
const source = readFileSync(path, "utf8"),
  match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n\r?\n([\s\S]*)$/);
if (!match) throw new Error("Invalid frontmatter");
const metadata = parse(match[1]),
  body = match[2].replace(/\n$/, "");
const rendered = await processMarkdown(
  body,
  metadata.media.map((m: any) => ({ ...m, name: m.url })),
);
metadata.summary = rendered.summary;
for (const image of metadata.media)
  image.digest = createHash("sha256")
    .update(readFileSync(`public${image.url}`))
    .digest("hex");
metadata.contentDigest = createHash("sha256")
  .update(
    JSON.stringify({
      title: metadata.title,
      authorId: metadata.authorId,
      markdown: body,
      media: metadata.media.map(({ name, digest }: any) => ({ name, digest })),
    }),
  )
  .digest("hex");
writeFileSync(
  path,
  `---\n${Object.entries(metadata)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n\n${body}\n`,
);
console.log(
  "Updated summary and content digest. Review the diff, validate, and build before merging.",
);
