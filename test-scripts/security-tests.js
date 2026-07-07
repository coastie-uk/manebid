#!/usr/bin/env node
"use strict";

const assert = require("assert/strict");
const crypto = require("crypto");
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
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/i, `${file} trusts jsDelivr`);
  }
});

test("SumUp callback rendering is static, normalized, and same-origin", () => {
  const payments = read("backend/payments.js");
  const resultPage = read("public/cashier/sumup-result.html");
  const resultScript = read("public/scripts/sumup-result.js");
  assert.doesNotMatch(payments, /res\.type\(['"]html['"]\)\.send/);
  assert.doesNotMatch(payments, /<strong>\s*\$\{status/);
  assert.match(payments, /res\.redirect\(303, `\$\{SUMUP_RESULT_PATH\}/);
  assert.match(resultScript, /new Set\(\["success", "failed", "invalidstate", "unknown"\]\)/);
  assert.match(resultScript, /\.textContent\s*=/);
  assert.doesNotMatch(resultScript, /\.innerHTML\s*=/);
  assert.doesNotMatch(resultPage, /<script(?![^>]*\bsrc=)/i);

  const expected = {
    "public/vendor/cropperjs/1.5.13/cropper.min.js": "r+ljwOAhwY4/kdyzMnuBg7MEVoWpTMp5EYUDntB/E9qzNwL9dAEcNrb2XaV+mJc2",
    "public/vendor/cropperjs/1.5.13/cropper.min.css": "oMy41mb/qJnpJlpXOF57hSu2KGi47l/UV9+tPNrBOs7/ap5Vubj/3phrCtjutHMQ"
  };
  for (const [file, digest] of Object.entries(expected)) {
    const actual = crypto.createHash("sha384")
      .update(fs.readFileSync(path.join(root, file)))
      .digest("base64");
    assert.equal(actual, digest, `${file} integrity mismatch`);
  }
});

test("SumUp app transactions require authoritative matching fields", () => {
  const { evaluateAppTransaction } = require(path.join(root, "backend/sumup-verification.js"));
  const intent = {
    intent_id: "11111111-1111-4111-8111-111111111111",
    amount_minor: 1250,
    currency: "GBP"
  };
  const transaction = {
    id: "provider-id",
    transaction_code: "TX-1",
    foreign_transaction_id: intent.intent_id,
    merchant_code: "merchant",
    amount: 12.5,
    currency: "GBP",
    status: "SUCCESSFUL"
  };
  const options = { merchantCode: "merchant", expectedTransactionCode: "TX-1" };
  assert.equal(evaluateAppTransaction(intent, transaction, options).status, "succeeded");
  for (const status of ["FAILED", "CANCELLED", "REFUNDED"]) {
    assert.equal(evaluateAppTransaction(intent, { ...transaction, status }, options).status, "failed");
  }
  assert.equal(
    evaluateAppTransaction(intent, { ...transaction, status: "PENDING" }, options).verification_state,
    "pending"
  );
  for (const [field, value] of [
    ["foreign_transaction_id", "other"],
    ["merchant_code", "other"],
    ["amount", 12.51],
    ["currency", "EUR"],
    ["transaction_code", "other"]
  ]) {
    const result = evaluateAppTransaction(intent, { ...transaction, [field]: value }, options);
    assert.equal(result.verification_state, "mismatch", `${field} mismatch was accepted`);
  }
});

test("SumUp client queries transactions by foreign reference and handles provider errors", async () => {
  const { getTransactionByForeignReference } = require(path.join(root, "backend/sumup-client.js"));
  const transaction = {
    id: "provider-id",
    foreign_transaction_id: "intent-id",
    status: "SUCCESSFUL"
  };
  let capturedUrl = "";
  let capturedOptions = null;
  const found = await getTransactionByForeignReference({
    request: async (url, options) => {
      capturedUrl = url;
      capturedOptions = options;
      return { statusCode: 200, body: { json: async () => transaction } };
    },
    apiKey: "test-key",
    merchantCode: "merchant/code",
    foreignTransactionId: "intent-id"
  });
  assert.deepEqual(found, transaction);
  assert.match(capturedUrl, /\/merchants\/merchant%2Fcode\/transactions\?foreign_transaction_id=intent-id$/);
  assert.equal(capturedOptions.method, "GET");
  assert.equal(capturedOptions.headers.Authorization, "Bearer test-key");
  assert.equal(capturedOptions.headersTimeout, 5000);
  assert.equal(capturedOptions.bodyTimeout, 10000);

  const missing = await getTransactionByForeignReference({
    request: async () => ({ statusCode: 404, body: { json: async () => ({}) } }),
    apiKey: "test-key",
    merchantCode: "merchant",
    foreignTransactionId: "intent-id"
  });
  assert.equal(missing, null);

  await assert.rejects(
    getTransactionByForeignReference({
      request: async () => ({ statusCode: 401, body: { json: async () => ({ error: "unauthorized" }) } }),
      apiKey: "test-key",
      merchantCode: "merchant",
      foreignTransactionId: "intent-id"
    }),
    /status 401/
  );
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
  const redactedPaymentUrl = redactSensitive(
    "/payments/sumup/callback/success?affiliate-key=abc123&foreign-tx-id=11111111-1111-4111-8111-111111111111&smp-tx-code=TX123"
  );
  assert.doesNotMatch(redactedPaymentUrl, /abc123|11111111-1111-4111-8111-111111111111|TX123/);
  const forged = redactSensitive("provider said ok\n[2026-01-01T00:00:00.000Z] [INFO] fake");
  assert.doesNotMatch(forged, /[\r\n]/);
  assert.match(forged, /provider said ok \[2026/);
  assert.doesNotMatch(read("public/scripts/maintenance.js"), /formatLogs\(/);
  assert.match(read("public/scripts/maintenance.js"), /document\.createTextNode/);
});

test("cashier renderers keep database text out of HTML parsing sinks", () => {
  const settlement = read("public/scripts/settlement.js");
  const liveFeed = read("public/scripts/live-feed.js");
  const backend = read("backend/backend.js");

  assert.match(settlement, /function appendTextCell/);
  assert.match(settlement, /safePhotoFilename\(l\.photo_url \|\| l\.photoUrl \|\| l\.photo/);
  assert.doesNotMatch(settlement, /tr\.innerHTML=`<td>\$\{l\.item_number\}<\/td><td>\$\{desc\}/);
  assert.doesNotMatch(settlement, /tr\.innerHTML = `<td>\$\{p\.id\}<\/td>/);
  assert.doesNotMatch(settlement, /figure\.innerHTML = `\s*<img src="\$\{uploadBase\}/);

  assert.match(liveFeed, /safePhotoFilename\(item\.photo\)/);
  assert.doesNotMatch(liveFeed, /figure\.innerHTML = `\s*<img src="\$\{API_ROOT\}/);
  assert.doesNotMatch(liveFeed, /dataset\.photoUrl = item\.photo/);

  assert.match(backend, /const fieldMaxLengths = \{/);
  assert.match(backend, /const sanitisedValue = sanitiseText\(req\.body\[field\], fieldMaxLengths\[field\]\)/);
  assert.doesNotMatch(backend, /params\.push\(req\.body\[field\]\)/);
});

test("upload, proxy, and dependency controls are configured", () => {
  const config = JSON.parse(read("backend/config.json"));
  assert.equal(config.HOST, "127.0.0.1");
  assert.deepEqual(config.TRUSTED_PROXIES, ["loopback", "192.168.0.254/32"]);
  assert.equal(config.ITEM_PHOTO_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(config.RESOURCE_IMAGE_MAX_BYTES, 10 * 1024 * 1024);
  assert.equal(config.RESOURCE_UPLOAD_MAX_FILES, 20);
  assert.equal(config.BACKUP_UPLOAD_MAX_BYTES, 512 * 1024 * 1024);
  assert.equal(config.BACKUP_ARCHIVE_MAX_EXPANDED_BYTES, 2 * 1024 * 1024 * 1024);
  assert.equal(config.BACKUP_ARCHIVE_MAX_ENTRY_BYTES, 512 * 1024 * 1024);
  assert.equal(config.BACKUP_ARCHIVE_MAX_ENTRIES, 10000);
  assert.equal(config.BACKUP_ARCHIVE_MAX_COMPRESSION_RATIO, undefined);
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
  assert.equal(packageJson.dependencies.yauzl.replace(/^[^\d]*/, ""), "3.4.0");
  const maintenance = read("backend/maintenance.js");
  const archive = read("backend/managed-backup-archive.js");
  assert.match(maintenance, /const \{ ZipArchive \} = require\("archiver"\)/);
  assert.match(maintenance, /new ZipArchive\(/);
  assert.doesNotMatch(maintenance, /\barchiver\("zip"/);
  assert.doesNotMatch(maintenance, /require\("jszip"\)/);
  assert.match(archive, /lazyEntries:\s*true/);
  assert.doesNotMatch(archive, /maxCompressionRatio|compression-ratio limit/);
  assert.match(archive, /maxExpandedBytes/);
  assert.match(archive, /pipeline\(/);
});

test("database restore permission gates sensitive backup routes", () => {
  const constants = read("backend/auth-constants.js");
  const users = read("backend/users.js");
  const maintenance = read("backend/maintenance.js");
  const browser = read("public/scripts/maintenance.js");
  assert.match(constants, /restore_database/);
  assert.match(users, /normalized === 'restore_database'/);
  assert.match(maintenance, /router\.get\("\/backups\/:backupId\/download", requireRestoreDatabase/);
  assert.match(maintenance, /router\.post\("\/backups\/import\/inspect", requireRestoreDatabase/);
  assert.match(maintenance, /router\.post\("\/backups\/import\/confirm", requireRestoreDatabase/);
  assert.match(maintenance, /router\.post\("\/backups\/:backupId\/restore", requireRestoreDatabase/);
  assert.match(browser, /\{ permission: "restore_database", role: "maintenance" \}/);
});

test("streaming ZIP limits reject expansion, per-entry, and entry-count abuse", async () => {
  const JSZip = require(path.join(root, "backend/node_modules/jszip"));
  const { processZipArchive } = require(path.join(root, "backend/managed-backup-archive.js"));
  const tempDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "manebid-zip-limits-"));
  const zipPath = path.join(tempDir, "limits.zip");
  const zip = new JSZip();
  zip.file("one.txt", Buffer.alloc(20000), { compression: "DEFLATE" });
  zip.file("two.txt", "second");
  fs.writeFileSync(zipPath, await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 }
  }));

  const defaults = {
    maxArchiveBytes: 1024 * 1024,
    maxExpandedBytes: 1024 * 1024,
    maxEntryBytes: 1024 * 1024,
    maxEntries: 10,
    validateEntryName() {}
  };
  try {
    await assert.rejects(
      processZipArchive(zipPath, { ...defaults, maxEntries: 1 }),
      /more than 1 entries/
    );
    await assert.rejects(
      processZipArchive(zipPath, { ...defaults, maxExpandedBytes: 100 }),
      /expanded size limit/
    );
    await assert.rejects(
      processZipArchive(zipPath, { ...defaults, maxEntryBytes: 100 }),
      /per-entry size limit/
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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
