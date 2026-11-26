import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TIMEOUT_MS = 30_000;
const NAVIGATE_TIMEOUT_MS = 60_000;

let playwrightModule = null;
let browserContext = null;
let activePage = null;

function logProcessError(label, error) {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(`[praxis-browser] ${label}: ${message}`);
}

process.on('unhandledRejection', (error) => {
  logProcessError('unhandledRejection', error);
});

process.on('uncaughtException', (error) => {
  logProcessError('uncaughtException', error);
});

function profileDir() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(localAppData, 'Praxis', 'browser-profile');
}

async function ensurePage() {
  if (activePage && !activePage.isClosed()) {
    return activePage;
  }

  if (!browserContext) {
    playwrightModule = playwrightModule || await import('playwright');
    const userDataDir = profileDir();
    await mkdir(userDataDir, { recursive: true });
    browserContext = await playwrightModule.chromium.launchPersistentContext(userDataDir, {
      headless: false,
    });
    browserContext.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    browserContext.setDefaultNavigationTimeout(NAVIGATE_TIMEOUT_MS);
  }

  activePage = browserContext.pages().find((page) => !page.isClosed()) || await browserContext.newPage();
  return activePage;
}

async function closeBrowser() {
  const context = browserContext;
  browserContext = null;
  activePage = null;
  if (context) {
    await context.close();
  }
}

function requestId(request) {
  return Object.prototype.hasOwnProperty.call(request, 'id') ? request.id : undefined;
}

function extractRequestId(line) {
  const match = line.match(/"id"\s*:\s*("(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?|true|false|null)/);
  if (!match) {
    return undefined;
  }

  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function commandName(request) {
  for (const field of ['command', 'cmd', 'action']) {
    if (typeof request[field] === 'string') {
      return request[field];
    }
  }
  return '';
}

function timeoutFor(request) {
  return commandName(request) === 'navigate' ? NAVIGATE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function okResponse(id, payload = {}) {
  const response = id === undefined ? {} : { id };
  return { ...response, ok: true, ...payload };
}

function errorResponse(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const response = id === undefined ? {} : { id };
  return { ...response, ok: false, error: message || 'error' };
}

function writeResponse(response) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`${JSON.stringify(response)}\n`, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function requireString(request, field) {
  if (typeof request[field] !== 'string' || request[field].length === 0) {
    throw new Error(`missing ${field}`);
  }
  return request[field];
}

async function pageTitle(page) {
  try {
    return await page.title();
  } catch {
    return '';
  }
}

async function dispatchCommand(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('request must be an object');
  }

  const command = commandName(request);

  switch (command) {
    case 'ping':
      return { pong: true };

    case 'status': {
      const page = activePage && !activePage.isClosed() ? activePage : null;
      return {
        ready: Boolean(browserContext),
        url: page ? page.url() : null,
        title: page ? await pageTitle(page) : '',
      };
    }

    case 'navigate': {
      const url = requireString(request, 'url');
      const page = await ensurePage();
      await page.goto(url, {
        waitUntil: typeof request.waitUntil === 'string' ? request.waitUntil : 'domcontentloaded',
        timeout: NAVIGATE_TIMEOUT_MS,
      });
      return {
        url: page.url(),
        title: await pageTitle(page),
      };
    }

    case 'fill': {
      const selector = requireString(request, 'selector');
      const value = request.value ?? request.text ?? '';
      const page = await ensurePage();
      await page.fill(selector, String(value));
      return {};
    }

    case 'click': {
      const selector = requireString(request, 'selector');
      const page = await ensurePage();
      await page.click(selector);
      return {};
    }

    case 'type': {
      const text = request.text ?? request.value;
      if (text === undefined || text === null) {
        throw new Error('missing text');
      }

      const page = await ensurePage();
      const options = typeof request.delay === 'number' ? { delay: request.delay } : undefined;
      if (typeof request.selector === 'string' && request.selector.length > 0) {
        await page.locator(request.selector).type(String(text), options);
      } else {
        await page.keyboard.type(String(text), options);
      }
      return {};
    }

    case 'press': {
      const key = requireString(request, 'key');
      const page = await ensurePage();
      if (typeof request.selector === 'string' && request.selector.length > 0) {
        await page.press(request.selector, key);
      } else {
        await page.keyboard.press(key);
      }
      return {};
    }

    case 'read': {
      const page = await ensurePage();
      const selector = typeof request.selector === 'string' && request.selector.length > 0
        ? request.selector
        : 'body';
      const text = await page.locator(selector).innerText();
      return {
        text,
        url: page.url(),
        title: await pageTitle(page),
      };
    }

    case 'screenshot': {
      const page = await ensurePage();
      const options = {
        fullPage: request.fullPage !== false,
      };

      if (typeof request.path === 'string' && request.path.length > 0) {
        await mkdir(path.dirname(request.path), { recursive: true });
        await page.screenshot({ ...options, path: request.path });
        return { path: request.path };
      }

      const image = await page.screenshot(options);
      return { data: image.toString('base64') };
    }

    case 'shutdown':
      await closeBrowser();
      return {};

    default:
      throw new Error(command ? `unknown command: ${command}` : 'missing command');
  }
}

async function processLine(line, dispatch, send, getTimeoutMs = timeoutFor) {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed) {
    return;
  }

  let request;
  let id;

  try {
    request = JSON.parse(trimmed);
    id = request && typeof request === 'object' ? requestId(request) : undefined;
  } catch (error) {
    await send(errorResponse(extractRequestId(trimmed), error));
    return;
  }

  try {
    const payload = await withTimeout(dispatch(request), getTimeoutMs(request));
    await send(okResponse(id, payload));
  } catch (error) {
    await send(errorResponse(id, error));
  }

  if (commandName(request) === 'shutdown') {
    setTimeout(() => process.exit(0), 0);
  }
}

function createLineProcessor(dispatch = dispatchCommand, send = writeResponse, getTimeoutMs = timeoutFor) {
  let buffer = '';
  let queue = Promise.resolve();

  function enqueue(line) {
    queue = queue
      .then(() => processLine(line, dispatch, send, getTimeoutMs))
      .catch((error) => logProcessError('line processor', error));
  }

  return {
    feed(chunk) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        enqueue(line);
      }
    },
    flush() {
      if (buffer.trim()) {
        enqueue(buffer);
        buffer = '';
      }
      return queue;
    },
    idle() {
      return queue;
    },
  };
}

async function runSelftest() {
  const responses = [];
  const processor = createLineProcessor(
    async (request) => {
      switch (request.command) {
        case 'ping':
          return { pong: true };
        case 'status':
          return { ready: false, url: null, title: '' };
        case 'navigate':
          return { url: request.url, title: 'stub' };
        case 'read':
          return { text: 'stub', url: 'about:blank', title: 'stub' };
        case 'slow':
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {};
        default:
          throw new Error('stub error');
      }
    },
    (response) => responses.push(response),
    (request) => request.command === 'slow' ? 5 : DEFAULT_TIMEOUT_MS,
  );

  processor.feed('{"id":1,"command":"ping"}\n\n{"id":2,"command":"navigate","url":"https://example.invalid"}\n{"id":3,"command":"read"}');
  processor.feed('\n{"id":4,"command":');
  processor.feed('"status"}\nnot-json {"id":5}\n{"id":6,"command":"slow"}\n{"id":7,"command":"unknown"}\n');
  await processor.flush();

  const expected = [
    [1, true],
    [2, true],
    [3, true],
    [4, true],
    [5, false],
    [6, false, 'timeout'],
    [7, false],
  ];

  for (const [index, [id, ok, error]] of expected.entries()) {
    const response = responses[index];
    if (!response || response.id !== id || response.ok !== ok) {
      throw new Error(`unexpected response ${index}: ${JSON.stringify(response)}`);
    }
    if (error && response.error !== error) {
      throw new Error(`unexpected error ${index}: ${JSON.stringify(response)}`);
    }
  }

  if (responses.length !== expected.length) {
    throw new Error(`unexpected response count: ${responses.length}`);
  }
}

if (process.argv.includes('--selftest')) {
  runSelftest()
    .then(() => {
      console.log('SELFTEST OK');
      process.exit(0);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    });
} else {
  const processor = createLineProcessor();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => processor.feed(chunk));
  process.stdin.on('end', () => {
    processor.flush().catch((error) => logProcessError('stdin flush', error));
  });
}
