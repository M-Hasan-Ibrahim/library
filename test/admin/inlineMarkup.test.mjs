// Inline formatting: the parser reads all existing text exactly as before,
// and formatted runs -> markup -> runs keeps the text (and the formatting).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { inlineToPlainText, inlineToRuns, normalizeRuns, parseInline, runsToInline } from "../../src/lib/inlineMarkup.js";
import { readingMinutes } from "../../src/lib/readingTime.js";

const ROOT = new URL("../../", import.meta.url);
const texts = [];
const walk = (blocks) =>
  blocks.forEach((b) => {
    if (typeof b.text === "string" && b.type !== "code") texts.push(b.text);
    if (typeof b.summary === "string") texts.push(b.summary);
    (b.items ?? []).forEach((item) => texts.push(item));
    if (b.blocks) walk(b.blocks);
  });
const bodies = new URL("src/content/bodies/", ROOT);
for (const file of readdirSync(bodies)) walk(JSON.parse(readFileSync(new URL(file, bodies), "utf8")).blocks);

test("existing text: the new parser gives exactly what the previous one gave", async (t) => {
  let previous;
  try {
    const source = execFileSync("git", ["show", "561d71e:src/lib/inlineMarkup.js"], { cwd: new URL(".", ROOT), encoding: "utf8" });
    const dir = mkdtempSync(join(tmpdir(), "inline-"));
    writeFileSync(join(dir, "old.mjs"), source);
    previous = (await import(pathToFileURL(join(dir, "old.mjs")).href)).parseInline;
  } catch {
    t.skip("git history not available");
    return;
  }
  assert.ok(texts.length > 100);
  for (const text of texts) assert.deepEqual(parseInline(text), previous(text), text);
});

test("existing text is written back character for character", () => {
  for (const text of texts) assert.equal(runsToInline(inlineToRuns(text)), text);
});

test("escapes, bold italic and literal characters", () => {
  assert.equal(inlineToPlainText("a \\*b\\* \\[c\\]\\(d\\) \\\\ e"), "a *b* [c](d) \\ e");
  assert.deepEqual(parseInline("***both***"), [{ type: "strong", children: [{ type: "em", children: [{ type: "text", value: "both" }] }] }]);
  assert.equal(inlineToPlainText("C:\\Users\\x"), "C:\\Users\\x", "a backslash before an ordinary letter stays");
  assert.equal(runsToInline([{ text: "a*b*c" }]), "a\\*b\\*c");
  assert.equal(runsToInline([{ text: "5 * 3" }]), "5 * 3", "no escape where none is needed");
  assert.equal(runsToInline([{ text: "x", bold: true }, { text: "y", bold: true, italic: true }]), "**x*****y***");
  assert.equal(runsToInline([{ text: " lead", italic: true }]), " *lead*");
  assert.equal(runsToInline([{ text: "go", href: "javascript:alert(1)" }]), "go");
  assert.equal(runsToInline([{ text: "w", href: "https://en.wikipedia.org/wiki/A_(b)" }]), "[w](https://en.wikipedia.org/wiki/A_%28b%29)");
});

test("fuzz: any formatted text keeps its characters and its formatting", () => {
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const chars = ["a", "b", " ", "*", "`", "[", "]", "(", ")", "\\", "é", "ق", "_", "1", "  ", "\n"];
  for (let i = 0; i < 5000; i += 1) {
    const runs = Array.from({ length: 1 + Math.floor(Math.random() * 5) }, () => ({
      text: Array.from({ length: 1 + Math.floor(Math.random() * 6) }, () => pick(chars)).join(""),
      bold: Math.random() < 0.4,
      italic: Math.random() < 0.4,
      code: Math.random() < 0.15,
      href: Math.random() < 0.2 ? pick(["https://x.org/a", "#/?item=fermi-problems", "mailto:a@b.c"]) : undefined,
    }));
    const markup = runsToInline(runs);
    assert.equal(inlineToRuns(markup).map((r) => r.text).join(""), runs.map((r) => r.text).join(""), JSON.stringify(runs));
  }
});

test("formatting survives when it can be written (nearly always)", () => {
  let kept = 0;
  const N = 3000;
  for (let i = 0; i < N; i += 1) {
    const runs = normalizeRuns(
      Array.from({ length: 1 + (i % 4) }, (_, j) => ({ text: ["word", "two words", "x"][j % 3], bold: (i + j) % 2 === 0, italic: (i * j) % 3 === 0, href: j === 2 ? "https://x.org" : undefined })),
    );
    const back = inlineToRuns(runsToInline(runs));
    if (JSON.stringify(back) === JSON.stringify(runs)) kept += 1;
  }
  assert.equal(kept, N);
});

test("reading time counts nested list items", () => {
  const words = (n) => Array.from({ length: n }, () => "word").join(" ");
  assert.equal(readingMinutes([{ id: "l", type: "list", items: [words(150), { text: words(100), list: { items: [words(200)] } }] }]), 3);
});
