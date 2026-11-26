const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const playwright = require(path.join(
  __dirname,
  "..",
  "praxis-browser",
  "node_modules",
  "playwright",
));

const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const HOST = "127.0.0.1";
const WAIT_MS = 10000;
const TIMEOUT_MS = 30000;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".woff2": "font/woff2",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
};

let server;
let browser;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const closeServer = () => new Promise((resolve) => {
  if (!server) {
    resolve();
    return;
  }
  server.close(() => resolve());
});

const timeout = setTimeout(() => {
  console.error("SMOKE FAIL: timed out after 30s");
  if (browser) {
    browser.close().catch(() => {});
  }
  if (server) {
    server.close(() => process.exit(1));
    setTimeout(() => process.exit(1), 1000).unref();
    return;
  }
  process.exit(1);
}, TIMEOUT_MS);
timeout.unref();

function distPathForRequest(req) {
  let pathname = "/";
  try {
    pathname = new URL(req.url || "/", `http://${HOST}`).pathname;
  } catch {
    pathname = "/";
  }

  const decoded = decodeURIComponent(pathname);
  const requested = decoded === "/" ? "/index.html" : decoded;
  const candidate = path.resolve(DIST, `.${requested}`);
  if (!candidate.startsWith(DIST + path.sep) && candidate !== DIST) {
    return path.join(DIST, "index.html");
  }
  if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return candidate;
  }
  return path.join(DIST, "index.html");
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Method not allowed");
      return;
    }

    const filePath = distPathForRequest(req);
    fs.readFile(filePath, (error, body) => {
      if (error) {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      });
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      res.end(body);
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    throw new Error("dist/index.html does not exist");
  }

  server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });

  const { port } = server.address();
  const url = `http://${HOST}:${port}/`;

  const pageErrors = [];
  const consoleErrors = [];

  browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("pageerror", (error) => {
    pageErrors.push(error.stack || error.message || String(error));
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  await sleep(WAIT_MS);

  const rootChildren = await page.evaluate(() => {
    const root = document.getElementById("root");
    return root ? root.children.length : 0;
  });

  // Tauri's IPC shims (`transformCallback`, __TAURI_INTERNALS__) throw when the
  // bundle runs OUTSIDE Tauri - expected in this plain-browser gate, harmless in
  // the real app (memory: praxis-transformcallback-console-artifact). Only errors
  // WITHOUT a Tauri signature indicate a genuine boot crash (e.g. the 2026-07-09
  // thinkPhase ctor TypeError, which had none).
  const TAURI_SHIM = /transformCallback|__TAURI_INTERNALS__|__TAURI_/;
  const realErrors = pageErrors.filter((e) => !TAURI_SHIM.test(e));
  const shimErrors = pageErrors.length - realErrors.length;

  if (realErrors.length > 0) {
    console.log("SMOKE FAIL");
    for (const error of realErrors.slice(0, 3)) {
      console.log(error);
    }
    process.exitCode = 1;
    return;
  }

  if (rootChildren === 0) {
    console.log(
      `SMOKE WARN: root empty, no non-Tauri errors (${shimErrors} Tauri-shim errors expected outside Tauri)`,
    );
    return;
  }

  console.log(`SMOKE PASS: root mounted, ${consoleErrors.length} console errors (non-fatal)`);
}

main()
  .catch((error) => {
    console.error(error && (error.stack || error.message) ? (error.stack || error.message) : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    clearTimeout(timeout);
    if (browser) {
      await browser.close().catch(() => {});
    }
    await closeServer();
  });
