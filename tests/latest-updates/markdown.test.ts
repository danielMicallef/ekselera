import test from "node:test";
import assert from "node:assert/strict";
import {
  processMarkdown,
  slugFor,
  dateLabel,
} from "../../src/features/latest-updates/markdown";
const media = [
  {
    name: "workflow.png",
    url: "/latest-updates/media/id/workflow.png",
    width: 640,
    height: 480,
  },
];
test("GFM prose, Unicode, lists, quotes, tables and code render with image dimensions", async () => {
  const source =
    'A new way to process invoices in Malta.\n\n## Café updates\n\n- One\n- Two\n\n> A quotation\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst value = "<safe>";\n```\n\n![Invoice workflow screenshot](workflow.png)';
  const article = await processMarkdown(source, media);
  for (const expected of [
    "<table>",
    "<blockquote>",
    "<ul>",
    "<pre>",
    'width="640"',
    'height="480"',
    "&#x3C;safe>",
  ])
    assert.ok(article.html.includes(expected), expected);
  assert.equal(article.summary, "A new way to process invoices in Malta.");
  assert.deepEqual(article.warnings, []);
  const production = await processMarkdown(
    article.markdown,
    media.map((m) => ({ ...m, name: m.url })),
  );
  assert.equal(production.html, article.html);
});
test("reference-style images resolve and preserve production rendering", async () => {
  const article = await processMarkdown(
    "Opening prose.\n\n![Meaningful screenshot][flow]\n\n[flow]: workflow.png",
    media,
  );
  const published = await processMarkdown(
    article.markdown,
    media.map((m) => ({ ...m, name: m.url })),
  );
  assert.equal(published.html, article.html);
  assert.ok(article.markdown.includes("/latest-updates/media/id/workflow.png"));
});
for (const [label, source] of Object.entries({
  html: "Prose\n\n<script>alert(1)</script>",
  frontmatter: "---\ntitle: hacked\n---\nProse",
  javascript: "Prose [link](javascript:alert%281%29)",
  data: "Prose [link](data:text/plain,hello)",
  remote: "Prose ![Remote screenshot](https://example.com/a.png)",
  traversal: "Prose ![Screenshot](../workflow.png)",
  missing: "Prose ![Screenshot](missing.png)",
  emptyAlt: "Prose ![](workflow.png)",
}))
  test(`rejects ${label}`, async () => {
    await assert.rejects(processMarkdown(source, media));
  });
test("warns on unused attachments without publishing them", async () => {
  const article = await processMarkdown("Opening prose.", media);
  assert.equal(article.warnings.length, 1);
  assert.deepEqual(article.used, []);
});
test("summary is capped at a word boundary", async () => {
  const article = await processMarkdown("Opening words ".repeat(50), []);
  assert.ok(article.summary.length <= 240);
  assert.match(article.summary, /words|Opening$/);
});
test("slug is stable, Unicode-aware and unique", () => {
  assert.equal(slugFor("Café & Malta", "abcdefgh-1234"), "cafe-malta-abcdefgh");
  assert.notEqual(
    slugFor("Same title", "12345678"),
    slugFor("Same title", "abcdefgh"),
  );
});
test("dates display in Malta rather than UTC", () => {
  assert.equal(dateLabel("2026-10-05T23:30:00Z"), "6 October 2026");
});
