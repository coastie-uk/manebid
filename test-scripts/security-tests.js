#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const walk = (directory, extension) => {
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walk(relative, extension));
    if (entry.isFile() && entry.name.endsWith(extension)) result.push(relative);
  }
  return result;
};

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test("all HTML uses CSP-compatible external scripts and handlers", () => {
  for (const file of walk("public", ".html")) {
    const html = read(file);
    assert.match(html, /http-equiv="Content-Security-Policy"/, `${file} lacks CSP meta`);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, `${file} contains inline script`);
    assert.doesNotMatch(html, /\son(?:click|change|submit|load|error)\s*=/i, `${file} contains inline handler`);
  }
});

test("browser code has no bearer authentication or token persistence", () => {
  const source = walk("public", ".js")
    .filter((file) => !file.endsWith("daypilot-modal-3.15.1.min.js"))
    .map(read)
    .join("\n");
  assert.doesNotMatch(source, /\bAuthorization\s*:/);
  assert.doesNotMatch(source, /setRequestHeader\(["']Authorization/);
  assert.doesNotMatch(source, /(?:local|session)Storage\.setItem\(["'][^"']*(?:token|Token)/);
  assert.doesNotMatch(source, /document\.write\(/);
  assert.doesNotMatch(source, /onclick=["']/);
  assert.match(source, /X-CSRF-Token/);
  assert.match(source, /authenticatedFetch/);
});

test("cashier polling avoids unchanged and overlapping renders", () => {
  const settlement = read("public/scripts/settlement.js");
  assert.match(settlement, /if \(fetchBiddersInFlight\) return/);
  assert.match(settlement, /nextRenderKey === bidderListRenderKey/);
  assert.match(settlement, /preserveUiState && !detailsChanged/);
});

test("session cookie and CSRF middleware are hardened", () => {
  const backend = read("backend/backend.js");
  const auth = read("backend/middleware/authenticateRole.js");
  const browserAuth = read("public/scripts/session-auth.js");
  assert.match(backend, /httpOnly:\s*true/);
  assert.match(backend, /sameSite:\s*['"]strict['"]/);
  assert.match(backend, /maxAge:\s*sessionTime \* 1000/);
  assert.match(auth, /X-CSRF-Token/);
  assert.doesNotMatch(auth, /req\.get\(['"]Authorization/);
  assert.match(browserAuth, /global\.__APP_SESSION__ \|\| getSharedSession\(\)/, "Preference hydration must retain the in-memory CSRF token");
  assert.match(browserAuth, /headers\.set\("X-CSRF-Token", csrfToken\)/);
});

test("browser session refresh retains CSRF only in memory", async () => {
  const values = new Map([["operatorSession", JSON.stringify({
    user: { username: "tester", roles: ["admin"], permissions: [], preferences: {} },
    landing_path: "/admin/index.html"
  })]]);
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
  const window = {
    localStorage: storage,
    sessionStorage: storage,
    document: { querySelectorAll: () => [] },
    location: { origin: "https://example.test", pathname: "/", search: "", replace() {} },
    addEventListener() {},
    dispatchEvent() {},
    setInterval,
    clearInterval
  };
  const fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => String(url).endsWith("/validate")
      ? {
          csrf_token: "csrf-regression-value",
          session_scope: "operator",
          user: { username: "tester", roles: ["admin"], permissions: [], preferences: {} },
          landing_path: "/admin/index.html"
        }
      : { preferences: { theme: { mode: "system" } } }
  });
  const context = vm.createContext({
    window,
    localStorage: storage,
    sessionStorage: storage,
    fetch,
    Headers,
    Blob,
    URL,
    CustomEvent: class CustomEvent {},
    console
  });
  vm.runInContext(read("public/scripts/session-auth.js"), context);
  const session = await window.AppAuth.refreshSession();
  assert.equal(session.csrf_token, "csrf-regression-value");
  assert.equal(window.AppAuth.getToken(), "csrf-regression-value");
  assert.doesNotMatch(values.get("operatorSession"), /csrf-regression-value/);
});

test("malformed tags and log values remain inert", () => {
  const { sanitiseText } = require(path.join(root, "backend/middleware/sanitiseText.js"));
  const { redactSensitive } = require(path.join(root, "backend/redact.js"));
  assert.equal(sanitiseText("safe<img src=x onerror=alert(1)", 255), "safe");
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abcdefghijklmno";
  assert.doesNotMatch(redactSensitive(`token ${jwt}`), /eyJ/);
  assert.doesNotMatch(read("public/scripts/maintenance.js"), /formatLogs\(/);
  assert.match(read("public/scripts/maintenance.js"), /document\.createTextNode/);
});

test("upload, proxy, and dependency controls are configured", () => {
  const config = JSON.parse(read("backend/config.json"));
  assert.equal(config.HOST, "127.0.0.1");
  assert.deepEqual(config.TRUSTED_PROXIES, ["loopback", "192.168.0.254/32"]);
  assert.equal(config.ITEM_PHOTO_MAX_BYTES, 10 * 1024 * 1024);
  const packageJson = JSON.parse(read("backend/package.json"));
  const expected = {
    express: "4.22.2",
    multer: "2.2.0",
    undici: "7.28.0",
    uuid: "11.1.1",
    archiver: "8.0.0",
    helmet: "8.2.0",
    "rate-limiter-flexible": "11.2.0"
  };
  for (const [name, version] of Object.entries(expected)) {
    assert.equal(packageJson.dependencies[name].replace(/^[^\d]*/, ""), version, `${name} version mismatch`);
  }
  assert.equal(packageJson.dependencies["body-parser"], undefined);
  const maintenance = read("backend/maintenance.js");
  assert.match(maintenance, /const \{ ZipArchive \} = require\("archiver"\)/);
  assert.match(maintenance, /new ZipArchive\(/);
  assert.doesNotMatch(maintenance, /\barchiver\("zip"/);
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}: ${error.message}`);
    }
  }
  console.log(`${tests.length - failed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
})();
