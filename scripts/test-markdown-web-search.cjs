/**
 * Contract tests for M-B: Atlas rich Markdown/Mermaid and text-first sourced search.
 * Run: node scripts/test-markdown-web-search.cjs
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

const root = path.resolve(__dirname, "..");

function load(relativePath) {
  const file = path.join(root, relativePath);
  const loader = path.extname(file).slice(1);
  const { code } = esbuild.transformSync(fs.readFileSync(file, "utf8"), {
    loader,
    format: "cjs",
    target: "es2020",
  });
  const mod = { exports: {} };
  new Function("module", "exports", "require", code)(mod, mod.exports, require);
  return mod.exports;
}

const search = load("src/voice/webSearchAnswer.ts");
const source = load("src/markdown/markdownSource.ts");
const urls = load("src/markdown/safeUrl.ts");
const repair = load("src/markdown/mermaidRepair.ts");
const safeHtml = load("src/markdown/remarkSafeHtml.ts");

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS  ${name}`);
}

test("explicit search language extracts only the query", () => {
  assert.equal(search.explicitWebSearchQuery("search the web for Tauri 2 release notes"), "Tauri 2 release notes");
  assert.equal(search.explicitWebSearchQuery("Atlas, could you look up online current Tauri docs?"), "current Tauri docs");
  assert.equal(search.explicitWebSearchQuery("web search: Praxis AI"), "Praxis AI");
  assert.equal(search.explicitWebSearchQuery("open the results in Edge"), null);
  assert.equal(search.explicitWebSearchQuery("what shipped?"), null);
});

test("spoken search stays brief and points to Atlas sources", () => {
  assert.equal(
    search.webSearchSpokenBrief({ query: "q", hits: [{ title: "One" }], brief: "The answer.", markdown: "m", summarized: true, pagesRead: 1 }),
    "The answer. I put the sources in Atlas.",
  );
  assert.match(search.webSearchSpokenBrief({ query: "q", hits: [], brief: "", markdown: "m", summarized: false, pagesRead: 0 }), /couldn't find results/);
});

test("streaming defers an unfinished Mermaid fence without losing source", () => {
  const partial = "Before\n```mermaid\ngraph TD\n  A-->B";
  assert.equal(source.hasUnclosedFence(partial), true);
  const shown = source.prepareMarkdown(partial, true);
  assert.match(shown, /```mermaid-pending/);
  assert.match(shown, /A-->B/);
  assert.equal(source.prepareMarkdown(`${partial}\n\`\`\``, true).includes("mermaid-pending"), false);
});

test("runaway Markdown is bounded on a Unicode boundary", () => {
  const huge = `${"a".repeat(source.MAX_MARKDOWN_CHARS - 1)}😀tail`;
  const shown = source.prepareMarkdown(huge);
  assert.ok(shown.length <= source.MAX_MARKDOWN_CHARS + 3);
  assert.ok(!shown.includes("\ud83d") && shown.endsWith("…"));
});

test("only credential-free absolute http(s) URLs become links", () => {
  assert.equal(urls.safeHttpUrl("https://example.com/a?q=1"), "https://example.com/a?q=1");
  assert.equal(urls.safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(urls.safeHttpUrl("file:///C:/secret"), null);
  assert.equal(urls.safeHttpUrl("https://good.example@evil.example/"), null);
  assert.equal(urls.safeHttpUrl("/relative"), null);
});

test("raw dangerous HTML drops both its tag and contents", () => {
  const tree = {
    type: "root",
    children: [
      { type: "paragraph", children: [
        { type: "text", value: "safe " },
        { type: "html", value: "<script>" },
        { type: "text", value: "stolen" },
        { type: "html", value: "</script>" },
        { type: "text", value: " answer" },
      ] },
    ],
  };
  safeHtml.remarkSafeHtml()(tree);
  assert.deepEqual(tree.children[0].children.map((n) => n.value), ["safe ", " answer"]);
});

test("Mermaid repair identifies diagrams and quotes unsafe labels", () => {
  assert.equal(repair.diagramKind("graph TD\nA-->B"), "flowchart");
  assert.equal(repair.diagramKind("sequenceDiagram\nA->>B: hi"), "sequence");
  const fixed = repair.repairMermaid("graph TD\nA[API: v2 (stable)] --> B");
  assert.match(fixed, /A\["API: v2 \(stable\)"\]/);
});

test("renderer, transcript, and both voice lanes share the rich-answer contract", () => {
  const panel = fs.readFileSync(path.join(root, "src/components/OrchestratorPanel.tsx"), "utf8");
  const bridge = fs.readFileSync(path.join(root, "src/voice/atlasChatBridge.ts"), "utf8");
  const tools = fs.readFileSync(path.join(root, "src/voice/hybridTools.ts"), "utf8");
  const router = fs.readFileSync(path.join(root, "src/voice/hybridRouter.ts"), "utf8");
  const rust = fs.readFileSync(path.join(root, "src-tauri/src/web_search.rs"), "utf8");
  const lib = fs.readFileSync(path.join(root, "src-tauri/src/lib.rs"), "utf8");
  assert.ok((panel.match(/<Markdown text=/g) ?? []).length >= 2, "typed and spoken Atlas answers render Markdown");
  assert.match(bridge, /displayMarkdown\?\.trim\(\) \|\| item\.detail/);
  assert.match(tools, /answer\.markdown/);
  assert.match(router, /answer\.markdown/);
  assert.match(rust, /const SUMMARY_PROVIDER: &str = "nvidia"/);
  assert.doesNotMatch(rust, /SUMMARY_PROVIDER[^\n]*(?:openai-api|openrouter)/);
  assert.match(lib, /web_search::web_search_answer/);
});

test("Mermaid is strict and SVG output gets an additional hardening pass", () => {
  const render = fs.readFileSync(path.join(root, "src/markdown/mermaidRender.ts"), "utf8");
  assert.match(render, /securityLevel:\s*"strict"/);
  assert.match(render, /replace\(\/<script/);
  assert.match(render, /javascript:/);
  assert.match(render, /htmlLabels:\s*false/);
});

console.log(`\nMarkdown + web search: ${passed}/${passed} passed`);
