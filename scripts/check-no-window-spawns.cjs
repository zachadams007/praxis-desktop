/**
 * Fails if a Windows process launch in src-tauri/src/*.rs can create a visible
 * console window. This is intentionally a lightweight source scan: Praxis has a
 * small number of command builders, and every Windows-capable std/tokio Command
 * must apply CREATE_NO_WINDOW before it is run or returned to callers.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "src-tauri", "src");
const CREATE_NO_WINDOW_HEX = /0x0?800_?0000/i;
const CREATE_NO_WINDOW_CONST = /\bconst\s+CREATE_NO_WINDOW\s*:\s*u32\s*=\s*0x0?800_?0000\b/i;
const COMMAND_NEW = /\b(?:std::process::Command|tokio::process::Command|Command)::new\s*\(/;
const TERMINAL_METHOD = /\.(?:spawn|output|status)\s*\(/;

function stripComments(line) {
  return line.replace(/\/\/.*$/, "");
}

function braceDelta(line) {
  const withoutStrings = stripComments(line).replace(/"(?:\\.|[^"\\])*"/g, '""');
  let delta = 0;
  for (const ch of withoutStrings) {
    if (ch === "{") delta += 1;
    if (ch === "}") delta -= 1;
  }
  return delta;
}

function cfgKind(line) {
  if (!/^\s*#\s*\[\s*cfg\s*\(/.test(line)) return null;
  if (/not\s*\(\s*windows\s*\)/.test(line)) return "not-windows";
  if (/\bwindows\b/.test(line)) return "windows";
  return "other";
}

function lineContexts(lines) {
  const contexts = new Array(lines.length);
  const stack = [];
  let pendingCfg = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComments(lines[i]);
    const trimmed = line.trim();
    contexts[i] = stack.map((entry) => entry.kind);

    const cfg = cfgKind(trimmed);
    if (cfg) {
      pendingCfg = cfg;
      continue;
    }

    const delta = braceDelta(line);
    if (pendingCfg && line.includes("{")) {
      stack.push({ kind: pendingCfg, depthAfterOpen: stack.length });
      contexts[i] = stack.map((entry) => entry.kind);
      pendingCfg = null;
    } else if (trimmed) {
      pendingCfg = null;
    }

    for (let closeCount = -delta; closeCount > 0 && stack.length; closeCount -= 1) {
      stack.pop();
    }
  }

  return contexts;
}

function findStatementEnd(lines, start) {
  let depth = 0;
  for (let i = start; i < lines.length; i += 1) {
    depth += braceDelta(lines[i]);
    if (depth <= 0 && /;/.test(stripComments(lines[i]))) return i;
  }
  return start;
}

function findAssignmentStart(lines, commandLine) {
  let candidate = commandLine;
  for (let i = commandLine; i >= Math.max(0, commandLine - 16); i -= 1) {
    const line = stripComments(lines[i]);
    if (
      /\blet\s+mut\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line) &&
      (COMMAND_NEW.test(line) || /=\s*(?:if|match|\{)/.test(line))
    ) {
      candidate = i;
    }
  }
  return candidate;
}

function findBlockEnd(lines, start) {
  let depth = 0;
  let seenOpen = false;
  for (let i = start; i < lines.length; i += 1) {
    const delta = braceDelta(lines[i]);
    if (delta > 0) seenOpen = true;
    depth += delta;
    if (seenOpen && depth <= 0 && i > start) return i;
  }
  return Math.min(lines.length - 1, start + 120);
}

function variableFromCommandStatement(statement) {
  const match = statement.match(/\blet\s+mut\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  return match ? match[1] : null;
}

function hasNoWindowFlag(segment, variable, fileHasConst, fileHasHideWindow) {
  if (CREATE_NO_WINDOW_HEX.test(segment)) return true;
  if (fileHasConst && /\bcreation_flags\s*\(\s*CREATE_NO_WINDOW\s*\)/.test(segment)) return true;
  if (
    variable &&
    fileHasHideWindow &&
    new RegExp(`\\bhide_window\\s*\\(\\s*&mut\\s+${variable}\\s*\\)`).test(segment)
  ) {
    return true;
  }
  return false;
}

function checkFile(file) {
  const fullPath = path.join(SRC, file);
  const text = fs.readFileSync(fullPath, "utf8");
  const lines = text.split(/\r?\n/);
  const contexts = lineContexts(lines);
  const fileHasConst = CREATE_NO_WINDOW_CONST.test(text);
  const fileHasHideWindow =
    /fn\s+hide_window\s*\([^)]*&mut\s+Command[^)]*\)[\s\S]*?creation_flags\s*\(\s*CREATE_NO_WINDOW\s*\)/.test(
      text,
    );
  const offenders = [];
  const checkedStarts = new Set();

  for (let i = 0; i < lines.length; i += 1) {
    if (!COMMAND_NEW.test(lines[i])) continue;
    if (contexts[i].includes("not-windows")) continue;

    const start = findAssignmentStart(lines, i);
    if (checkedStarts.has(start)) continue;
    checkedStarts.add(start);

    const statementEnd = findStatementEnd(lines, start);
    const statement = lines.slice(start, statementEnd + 1).join("\n");
    const variable = variableFromCommandStatement(statement);

    let end = statementEnd;
    if (variable) {
      end = Math.min(lines.length - 1, statementEnd + 120);
      for (let j = statementEnd + 1; j <= end; j += 1) {
        if (TERMINAL_METHOD.test(stripComments(lines[j]))) {
          end = j;
          break;
        }
      }
    } else {
      for (let j = start; j < lines.length; j += 1) {
        if (TERMINAL_METHOD.test(stripComments(lines[j]))) {
          end = j;
          break;
        }
        if (j > start && COMMAND_NEW.test(lines[j])) break;
      }
    }

    const segment = lines.slice(start, end + 1).join("\n");
    if (!hasNoWindowFlag(segment, variable, fileHasConst, fileHasHideWindow)) {
      offenders.push({
        file,
        line: start + 1,
        command: lines[start].trim(),
      });
    }
  }

  return offenders;
}

const offenders = fs
  .readdirSync(SRC)
  .filter((file) => file.endsWith(".rs"))
  .flatMap(checkFile);

if (offenders.length) {
  console.error("FAIL: Windows Command spawns missing CREATE_NO_WINDOW:");
  for (const offender of offenders) {
    console.error(`  ${offender.file}:${offender.line}  ${offender.command}`);
  }
  process.exit(1);
}

console.log("PASS: all Windows Command spawns apply CREATE_NO_WINDOW");
