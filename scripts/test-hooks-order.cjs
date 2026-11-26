/**
 * No React component may call a hook after an early return at its top level.
 *
 * Live 2026-10-10: DetailCard (the dock's Inspector) returned early when the selected
 * node wasn't on the map, then called useMemo/useExistingPaths. A mission focused its
 * new journey node before the graph held it, the hook count changed (React #300), and
 * the whole main window went blank. This scan fails the gate on that shape.
 * Heuristic: lines indented exactly one level inside a capitalised component.
 * Run: node scripts/test-hooks-order.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const DECL = /^(\s*)(?:export\s+(?:default\s+)?)?(?:function\s+([A-Z]\w*)\s*\(|const\s+([A-Z]\w*)\s*(?::[^=]+)?=\s*(?:React\.)?(?:memo\()?\s*(?:\([^)]*\)|\w+)\s*=>\s*\{)/;
const HOOK = /\buse[A-Z]\w*\s*(?:<[^>]*>)?\(/;
const RET = /^\s*(?:if\s*\(.*\)\s*)?return\b/;

function* tsxFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsxFiles(p);
    else if (entry.name.endsWith(".tsx")) yield p;
  }
}

const hits = [];
let components = 0;
for (const file of tsxFiles(SRC)) {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = DECL.exec(lines[i]);
    if (!m) continue;
    components++;
    const base = m[1].length;
    const body = base + 2;
    let firstReturn = -1;
    let j = i + 1;
    for (; j < lines.length; j++) {
      const line = lines[j];
      const t = line.trim();
      const ind = line.length - line.trimStart().length;
      if (t === "}" && ind === base) break;
      if (!t || ind !== body) continue;
      if (firstReturn < 0 && RET.test(line) && !t.startsWith("return (")) firstReturn = j;
      else if (firstReturn >= 0 && HOOK.test(line)) {
        hits.push(`${path.relative(SRC, file)}:${j + 1} ${m[2] || m[3]} calls a hook after the early return on line ${firstReturn + 1}`);
        break;
      }
    }
    i = j;
  }
}

if (hits.length) {
  console.error("FAIL — hooks after an early return (React #300/#310 blanks the window):\n  " + hits.join("\n  "));
  process.exit(1);
}
console.log(`PASS — ${components} components scanned, 0 hooks after an early return`);
