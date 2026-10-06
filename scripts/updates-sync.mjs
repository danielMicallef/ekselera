import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2),
  target = resolve(
    args.find((a) => !a.startsWith("--")) ||
      "/Users/danielmicallef/edev/ziffa/astro_landing",
  );
const dry = args.includes("--dry-run"),
  install = args.includes("--install");
if (source === target) throw new Error("Source and target must differ");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const feature = "src/features/latest-updates";
async function walk(path) {
  const result = [];
  for (const entry of await readdir(resolve(source, path), {
    withFileTypes: true,
  })) {
    const name = `${path}/${entry.name}`;
    result.push(...(entry.isDirectory() ? await walk(name) : [name]));
  }
  return result;
}
const owned = [
  ...(await walk(feature)),
  "docs/latest-updates.md",
  "scripts/updates-validate.ts",
  "scripts/updates-sync.mjs",
  "scripts/updates-reseal.ts",
  "scripts/updates-ci-callback.mjs",
  ...(await walk("tests/latest-updates")),
];
const manifestPath = resolve(target, ".latest-updates-module.json");
let previous = { files: {} };
try {
  previous = JSON.parse(await readFile(manifestPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const packageJson = JSON.parse(
  await readFile(resolve(target, "package.json"), "utf8"),
);
if (!/\b5\./.test(packageJson.dependencies?.astro || ""))
  throw new Error("Requires Astro 5; review compatibility before syncing");
for (const dependency of [
  "unified",
  "remark-parse",
  "remark-gfm",
  "remark-rehype",
  "rehype-stringify",
  "unist-util-visit",
  "image-size",
  "yaml",
])
  if (!packageJson.dependencies?.[dependency])
    throw new Error(`Missing dependency: ${dependency}`);
const canonicalPackage = JSON.parse(
  await readFile(resolve(source, "package.json"), "utf8"),
);
for (const dependency of [
  "unified",
  "remark-parse",
  "remark-gfm",
  "remark-rehype",
  "rehype-stringify",
  "unist-util-visit",
  "image-size",
  "yaml",
]) {
  if (
    packageJson.dependencies[dependency].match(/\d+/)?.[0] !==
    canonicalPackage.dependencies[dependency].match(/\d+/)?.[0]
  )
    throw new Error(`Incompatible dependency: ${dependency}`);
}
const removed = Object.keys(previous.files).filter(
  (path) => !owned.includes(path),
);
for (const path of removed) {
  if (path.split("/").includes("..") || !path.startsWith(feature + "/"))
    throw new Error(`Unexpected removed module path: ${path}`);
  try {
    if (sha(await readFile(resolve(target, path))) !== previous.files[path])
      throw new Error(`Locally modified removed file: ${path}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(`${dry ? "Would remove" : "Remove"} ${path}`);
}
if (!install) {
  for (const [path, marker] of [
    ["src/content.config.ts", "updates"],
    ["src/pages/latest-updates/[...slug].astro", "UpdatesPage"],
    ["src/components/Navbar.astro", "publishedUpdates"],
    ["src/components/Footer.astro", "publishedUpdates"],
    ["src/config/latest-updates.ts", "serviceOrigin"],
  ]) {
    if (!(await readFile(resolve(target, path), "utf8")).includes(marker))
      throw new Error(`Missing integration: ${path}`);
  }
}
const contents = new Map();
for (const path of owned) {
  const bytes = await readFile(resolve(source, path));
  contents.set(path, bytes);
  try {
    const local = await readFile(resolve(target, path));
    if (sha(local) !== sha(bytes) && sha(local) !== previous.files[path])
      throw new Error(
        `Locally modified owned file: ${path}. Save/review it before syncing.`,
      );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  console.log(`${dry ? "Would sync" : "Sync"} ${path}`);
}
if (!dry) {
  for (const path of removed) {
    try {
      await unlink(resolve(target, path));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const [path, bytes] of contents) {
    await mkdir(dirname(resolve(target, path)), { recursive: true });
    await writeFile(resolve(target, path), bytes);
  }
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        version: "1.0.1",
        files: Object.fromEntries(
          [...contents].map(([path, bytes]) => [path, sha(bytes)]),
        ),
      },
      null,
      2,
    ) + "\n",
  );
}
