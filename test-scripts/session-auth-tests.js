const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../public/scripts/session-auth.js'), 'utf8');

function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent(event) {
      listeners.get(event.type)?.forEach(listener => listener(event));
    }
  };
}

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); }
  };
}

function createContext(fetchImpl) {
  const windowEvents = createEventTarget();
  const documentEvents = createEventTarget();
  const localStorage = createStorage();
  const sessionStorage = createStorage();
  const session = {
    csrf_token: 'csrf-token',
    session_scope: 'operator',
    user: { username: 'tester', roles: ['admin'], permissions: [], preferences: {} }
  };
  localStorage.setItem('operatorSession', JSON.stringify(session));

  const window = {
    ...windowEvents,
    document: { ...documentEvents, visibilityState: 'visible' },
    localStorage,
    sessionStorage,
    fetch: fetchImpl,
    Headers,
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    __APP_SESSION__: session
  };
  const context = vm.createContext({ window, document: window.document, localStorage, sessionStorage, fetch: fetchImpl, Headers, setTimeout });
  vm.runInContext(source, context, { filename: 'session-auth.js' });
  return window;
}

async function testPreferencesFlushBeforeLogout() {
  const requests = [];
  const window = createContext(async (url, options = {}) => {
    requests.push({ url, options });
    return { ok: true, status: url.endsWith('/logout') ? 204 : 200, json: async () => ({}) };
  });
  const controller = window.AppAuth.createPreferenceController({ pageKey: 'admin' });
  controller.patchPagePreferences({ selected_auction_id: 42 });

  await window.AppAuth.logout();

  assert.deepEqual(requests.map(request => request.url), ['/api/preferences', '/api/logout']);
  assert.equal(JSON.parse(requests[0].options.body).preferences.admin.selected_auction_id, 42);
}

async function testFailedFlushDoesNotPreventLogout() {
  const requests = [];
  const window = createContext(async (url) => {
    requests.push(url);
    if (url.endsWith('/preferences')) throw new Error('save failed');
    return { ok: true, status: 204, json: async () => ({}) };
  });
  const controller = window.AppAuth.createPreferenceController({ pageKey: 'cashier' });
  controller.patchPagePreferences({ selected_auction_id: 7 });

  await window.AppAuth.logout();

  assert.deepEqual(requests, ['/api/preferences', '/api/logout']);
}

(async () => {
  await testPreferencesFlushBeforeLogout();
  await testFailedFlushDoesNotPreventLogout();
  console.log('PASS session preference logout tests');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
