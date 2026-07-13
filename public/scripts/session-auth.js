(function initSessionAuth(global) {
  "use strict";

  const API = "/api";
  const STORAGE_KEY = "operatorSession";
  const LAST_VIEW_KEY = "operatorLastView";
  const LOGOUT_KEY = "operatorLogoutEvent";
  const KIOSK_KEY = "slideshowKioskSession";
  const SESSION_EVENT = "appauth:session";
  const SESSION_REFRESH_MS = 60000;
  const PREFERENCES_API = `${API}/preferences`;
  const PREFERENCE_SAVE_MS = 180000;
  const preferenceControllers = new Set();
  const LEGACY_TOKEN_KEYS = ["token", "cashierToken", "maintenanceToken"];
  const ACCESS_LABELS = Object.freeze({
    admin: "Manage Items",
    cashier: "Manage Payments",
    maintenance: "Manage Auctions",
    live_feed: "Manage Collections",
    admin_bidding: "Manage Bids",
    slideshow: "Slideshow",
    manage_users: "Manage Users",
    restore_database: "Restore Database"
  });
  const ACCESS_ORDER = Object.freeze([
    "admin",
    "cashier",
    "maintenance",
    "live_feed",
    "admin_bidding",
    "manage_users",
    "restore_database",
    "slideshow"
  ]);
  const VIEWS = Object.freeze([
    { key: "admin", path: "/admin/index.html", role: "admin" },
    { key: "cashier", path: "/cashier/index.html", role: "cashier" },
    { key: "maintenance", path: "/maint/index.html", role: "maintenance" },
    { key: "live_feed", path: "/cashier/live-feed.html", permission: "live_feed" },
    { key: "slideshow", path: "/slideshow/index.html", role: "slideshow" }
  ]);

  function safeParse(value) {
    if (!value || typeof value !== "string") return null;
    try {
      return JSON.parse(value);
    } catch (_error) {
      return null;
    }
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function isPlainObject(value) {
    return value && typeof value === "object" && !Array.isArray(value);
  }

  function normalisePreferences(preferences) {
    return isPlainObject(preferences) ? cloneJson(preferences) : {};
  }

  function normaliseStringList(values) {
    if (!Array.isArray(values)) return [];
    return values
      .map((value) => String(value || "").trim().toLowerCase())
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index);
  }

  function normaliseUser(user) {
    const roles = normaliseStringList(user?.roles);
    const permissions = normaliseStringList(user?.permissions);
    return {
      username: user?.username || null,
      role: user?.role || roles[0] || null,
      roles,
      permissions,
      preferences: normalisePreferences(user?.preferences),
      is_root: Number(user?.is_root) === 1 ? 1 : 0
    };
  }

  function getDefaultLandingPath(user) {
    const view = VIEWS.find((candidate) => hasViewAccess(user, candidate));
    return view?.path || "/login.html";
  }

  function normaliseSession(payload) {
    if (!payload || typeof payload !== "object") return null;
    const user = normaliseUser(payload.user || payload);
    return {
      csrf_token: typeof payload.csrf_token === "string" ? payload.csrf_token : null,
      session_scope: payload.session_scope || "operator",
      user,
      versions: payload.versions || null,
      landing_path: payload.landing_path || getDefaultLandingPath(user)
    };
  }

  function clearLegacyTokens() {
    LEGACY_TOKEN_KEYS.forEach((key) => {
      localStorage.removeItem(key);
      sessionStorage.removeItem(key);
    });
  }
  clearLegacyTokens();

  function getSharedSession() {
    return normaliseSession(safeParse(localStorage.getItem(STORAGE_KEY)));
  }

  function getKioskSession() {
    return normaliseSession(safeParse(sessionStorage.getItem(KIOSK_KEY)));
  }

  function writeStoredSession(session) {
    if (!session) return null;
    const { csrf_token: _csrfToken, ...nonSensitiveMetadata } = session;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(nonSensitiveMetadata));
    global.__APP_SESSION__ = session;
    return session;
  }

  function saveSharedSession(payload) {
    const existing = getSharedSession();
    let nextPayload = payload;
    if (payload?.user && payload.user.preferences === undefined && existing?.user?.preferences) {
      nextPayload = {
        ...payload,
        user: {
          ...payload.user,
          preferences: existing.user.preferences
        }
      };
    }
    const session = normaliseSession(nextPayload);
    if (!session) return null;
    return writeStoredSession(session);
  }

  function saveKioskSession(payload) {
    const session = normaliseSession(payload);
    if (!session) return null;
    const { csrf_token: _csrfToken, ...nonSensitiveMetadata } = session;
    sessionStorage.setItem(KIOSK_KEY, JSON.stringify(nonSensitiveMetadata));
    global.__APP_KIOSK_SESSION__ = session;
    return session;
  }

  function clearKioskSession() {
    sessionStorage.removeItem(KIOSK_KEY);
    delete global.__APP_KIOSK_SESSION__;
  }

  function clearSharedSession({ broadcast = true } = {}) {
    localStorage.removeItem(STORAGE_KEY);
    clearLegacyTokens();
    delete global.__APP_SESSION__;
    if (broadcast) {
      localStorage.setItem(LOGOUT_KEY, String(Date.now()));
    }
  }

  function clearAllSessions({ broadcast = true } = {}) {
    clearKioskSession();
    clearSharedSession({ broadcast });
  }

  function getAppliedPreferences() {
    const session = global.__APP_SESSION__ || getSharedSession();
    return normalisePreferences(session?.user?.preferences);
  }

  function setAppliedPreferences(preferences) {
    const session = global.__APP_SESSION__ || getSharedSession();
    const normalized = normalisePreferences(preferences);
    if (!session) return normalized;

    const updatedSession = {
      ...session,
      user: {
        ...session.user,
        preferences: normalized
      }
    };
    writeStoredSession(updatedSession);
    return normalized;
  }

  async function validateSession() {
    const response = await fetch(`${API}/validate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: "{}"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || "Session expired");
      error.reason = data?.reason || "";
      throw error;
    }
    return data;
  }

  async function fetchPreferences(token) {
    const response = await fetch(PREFERENCES_API, {
      method: "GET",
      credentials: "same-origin"
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || "Failed to load preferences");
      error.reason = data?.reason || "";
      throw error;
    }
    return normalisePreferences(data?.preferences);
  }

  async function hydrateSharedPreferences(session) {
    if (!session) return session;
    if (global.__APP_SHARED_PREFERENCES_HYDRATED__) return session;

    global.__APP_SHARED_PREFERENCES_HYDRATED__ = true;
    const startingPreferencesJson = JSON.stringify(normalisePreferences(session?.user?.preferences));
    try {
      const preferences = await fetchPreferences();
      const currentSession = global.__APP_SESSION__ || getSharedSession();
      const currentPreferences = normalisePreferences(currentSession?.user?.preferences);
      const currentPreferencesJson = JSON.stringify(currentPreferences);
      const nextPreferences = currentPreferencesJson !== startingPreferencesJson
        ? { ...preferences, ...currentPreferences }
        : preferences;
      const baseSession = currentSession || session;
      return saveSharedSession({
        ...baseSession,
        user: {
          ...(baseSession.user || {}),
          preferences: nextPreferences
        }
      });
    } catch (_error) {
      return session;
    }
  }

  async function refreshSession({ allowKiosk = false, propagateError = false } = {}) {
    try {
      const validated = await validateSession();
      const isKiosk = validated.session_scope === "slideshow";
      if (isKiosk && !allowKiosk) return null;
      let session = isKiosk ? saveKioskSession(validated) : saveSharedSession(validated);
      if (!isKiosk) session = await hydrateSharedPreferences(session);
      return session ? { ...session, scope: isKiosk ? "kiosk" : "shared" } : null;
    } catch (error) {
      clearAllSessions({ broadcast: false });
      if (propagateError) throw error;
      return null;
    }
  }

  function hasRole(user, role) {
    return normaliseUser(user).roles.includes(String(role || "").trim().toLowerCase());
  }

  function hasPermission(user, permission) {
    return normaliseUser(user).permissions.includes(String(permission || "").trim().toLowerCase());
  }

  function getAccessKeys(user) {
    const normalized = normaliseUser(user);
    const combined = [...normalized.roles, ...normalized.permissions];
    const seen = new Set();
    return ACCESS_ORDER.filter((key) => {
      if (!combined.includes(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function getAccessLabels(user) {
    const keys = getAccessKeys(user);
    return keys.map((key) => ACCESS_LABELS[key] || key);
  }

  function hasViewAccess(user, view) {
    if (!user || !view) return false;
    if (view.role) return hasRole(user, view.role);
    if (view.permission) return hasPermission(user, view.permission);
    return false;
  }

  function canAccess(user, access = {}) {
    if (access.viewKey) {
      const mappedView = VIEWS.find((candidate) => candidate.key === access.viewKey);
      return hasViewAccess(user, mappedView);
    }
    if (access.role && !hasRole(user, access.role)) return false;
    if (access.permission && !hasPermission(user, access.permission)) return false;
    return true;
  }

  function describeAccess(user) {
    const labels = getAccessLabels(user);
    return labels.length ? labels.join(", ") : "No assigned access";
  }

  function rememberView(viewKey) {
    if (!viewKey) return;
    if (viewKey === "slideshow") {
      localStorage.removeItem(LAST_VIEW_KEY);
      return;
    }
    localStorage.setItem(LAST_VIEW_KEY, viewKey);
  }

  function getStoredView() {
    const viewKey = (localStorage.getItem(LAST_VIEW_KEY) || "").trim();
    if (!viewKey || viewKey === "slideshow") {
      if (viewKey === "slideshow") {
        localStorage.removeItem(LAST_VIEW_KEY);
      }
      return null;
    }
    return VIEWS.find((view) => view.key === viewKey) || null;
  }

  function getPathView(pathname) {
    const cleanedPath = String(pathname || "").replace(/\/+$/, "") || "/";
    return VIEWS.find((view) => view.path.replace(/\/+$/, "") === cleanedPath) || null;
  }

  function resolveLandingPath(user, preferredPath = "") {
    const preferredView = getPathView(preferredPath);
    if (preferredView && hasViewAccess(user, preferredView)) return preferredView.path;

    const storedView = getStoredView();
    if (storedView && hasViewAccess(user, storedView)) return storedView.path;

    return getDefaultLandingPath(user);
  }

  function disableAnchor(anchor) {
    if (!anchor.dataset.disabledHref && anchor.hasAttribute("href")) {
      anchor.dataset.disabledHref = anchor.getAttribute("href");
    }
    anchor.removeAttribute("href");
    anchor.setAttribute("aria-disabled", "true");
    anchor.classList.add("is-disabled-access");
    if (!anchor.dataset.accessBound) {
      anchor.addEventListener("click", (event) => {
        if (anchor.getAttribute("aria-disabled") === "true") {
          event.preventDefault();
        }
      });
      anchor.dataset.accessBound = "1";
    }
  }

  function enableAnchor(anchor) {
    if (anchor.dataset.disabledHref) {
      anchor.setAttribute("href", anchor.dataset.disabledHref);
    }
    anchor.setAttribute("aria-disabled", "false");
    anchor.classList.remove("is-disabled-access");
  }

  function applyAccessState(root, user) {
    if (!root) return;
    root.querySelectorAll("[data-access-role], [data-access-permission]").forEach((element) => {
      const access = {
        role: element.dataset.accessRole || "",
        permission: element.dataset.accessPermission || ""
      };
      const allowed = canAccess(user, access);

      if (element.tagName === "A") {
        if (allowed) {
          enableAnchor(element);
        } else {
          disableAnchor(element);
        }
        return;
      }

      if ("disabled" in element) {
        element.disabled = !allowed;
      }
      element.classList.toggle("is-disabled-access", !allowed);
      if (!allowed) {
        element.setAttribute("aria-disabled", "true");
      } else {
        element.removeAttribute("aria-disabled");
      }
    });
  }

  function redirectToLogin({ reason = "", next = "" } = {}) {
    const url = new URL("/login.html", global.location.origin);
    const redirectTarget = next || `${global.location.pathname}${global.location.search}`;
    if (reason) url.searchParams.set("reason", reason);
    if (redirectTarget) url.searchParams.set("next", redirectTarget);
    global.location.replace(`${url.pathname}${url.search}`);
  }

  function getCurrentScope() {
    return global.__APP_AUTH_BOOTSTRAP__?.scope
      || (getKioskSession() ? "kiosk" : null)
      || (getSharedSession() ? "shared" : null);
  }

  function installLogoutSync() {
    if (global.__APP_LOGOUT_SYNC_BOUND__) return;
    global.__APP_LOGOUT_SYNC_BOUND__ = true;

    global.addEventListener("storage", (event) => {
      if (getCurrentScope() === "kiosk") return;

      if (event.key === LOGOUT_KEY) {
        redirectToLogin({ reason: "signed_out" });
        return;
      }

      if (event.key === STORAGE_KEY && !event.newValue) {
        redirectToLogin({ reason: "signed_out" });
      }
    });
  }

  function publishSession(session, config = {}) {
    if (!session) return null;
    global.__APP_AUTH_BOOTSTRAP__ = { ...session, config: config || {} };
    global.dispatchEvent(new CustomEvent(SESSION_EVENT, {
      detail: global.__APP_AUTH_BOOTSTRAP__
    }));
    return global.__APP_AUTH_BOOTSTRAP__;
  }

  function stopSessionRefresh() {
    if (!global.__APP_SESSION_REFRESH_TIMER__) return;
    global.clearInterval(global.__APP_SESSION_REFRESH_TIMER__);
    delete global.__APP_SESSION_REFRESH_TIMER__;
  }

  function expireProtectedSession(scope, reason = "signed_out") {
    stopSessionRefresh();
    if (scope === "kiosk") {
      clearKioskSession();
    } else {
      clearSharedSession({ broadcast: true });
    }
    redirectToLogin({ reason });
  }

  async function refreshProtectedPage(config) {
    let session = null;
    try {
      session = await refreshSession({ allowKiosk: Boolean(config?.allowKiosk), propagateError: true });
    } catch (error) {
      const redirectReason = error?.reason === "remote_logout" ? "remote_logout" : "signed_out";
      expireProtectedSession(global.__APP_AUTH_BOOTSTRAP__?.scope || "shared", redirectReason);
      return null;
    }
    if (!session) {
      expireProtectedSession(global.__APP_AUTH_BOOTSTRAP__?.scope || "shared");
      return null;
    }

    if (!canAccess(session.user, config?.access || { viewKey: config?.viewKey })) {
      if (session.scope === "kiosk") {
        clearKioskSession();
      } else {
        clearSharedSession({ broadcast: true });
      }
      stopSessionRefresh();
      redirectToLogin({ reason: "signed_out" });
      return null;
    }

    if (config?.viewKey) rememberView(config.viewKey);
    applyAccessState(global.document, session.user);
    return publishSession(session, config);
  }

  function startSessionRefresh(config) {
    stopSessionRefresh();
    global.__APP_SESSION_REFRESH_TIMER__ = global.setInterval(() => {
      refreshProtectedPage(config).catch((error) => {
        expireProtectedSession(
          global.__APP_AUTH_BOOTSTRAP__?.scope || "shared",
          error?.reason === "remote_logout" ? "remote_logout" : "signed_out"
        );
      });
    }, SESSION_REFRESH_MS);
  }

  async function protectPage(config) {
    const session = await refreshProtectedPage(config);
    if (!session) return null;
    installLogoutSync();
    startSessionRefresh(config);
    return session;
  }

  async function startSlideshowKiosk() {
    const shared = getSharedSession();
    if (!shared || !canAccess(shared.user, { role: "slideshow" })) return null;
    const response = await authenticatedFetch(`${API}/session/kiosk`, { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not start kiosk session");
    const kiosk = saveKioskSession(data);
    clearSharedSession({ broadcast: true });
    return publishSession({ ...kiosk, scope: "kiosk" }, global.__APP_AUTH_BOOTSTRAP__?.config || {});
  }

  function getToken() {
    return global.__APP_AUTH_BOOTSTRAP__?.csrf_token
      || global.__APP_SESSION__?.csrf_token
      || global.__APP_KIOSK_SESSION__?.csrf_token
      || null;
  }

  function authenticatedFetch(input, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const headers = new Headers(options.headers || {});
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const csrfToken = getToken();
      if (!csrfToken) return Promise.reject(new Error("No active session"));
      headers.set("X-CSRF-Token", csrfToken);
    }
    return fetch(input, { ...options, headers, credentials: "same-origin" });
  }

  async function logout() {
    const csrfToken = getToken();
    try {
      await Promise.allSettled(
        Array.from(preferenceControllers, (controller) => controller.flush({ keepalive: true }))
      );
      if (csrfToken) await authenticatedFetch(`${API}/logout`, { method: "POST" });
    } finally {
      clearAllSessions({ broadcast: true });
    }
  }

  function createPreferenceController({ pageKey, saveIntervalMs = PREFERENCE_SAVE_MS } = {}) {
    const normalisedPageKey = String(pageKey || "").trim();
    if (!normalisedPageKey) {
      throw new Error("Preference controller requires a pageKey");
    }

    let documentState = getAppliedPreferences();
    let lastSavedJson = JSON.stringify(documentState);
    let flushPromise = null;

    function rebaseDocumentOnAppliedPreferences() {
      const applied = getAppliedPreferences();
      const pagePreferences = isPlainObject(documentState[normalisedPageKey])
        ? documentState[normalisedPageKey]
        : {};
      documentState = {
        ...applied,
        [normalisedPageKey]: cloneJson(pagePreferences)
      };
      return documentState;
    }

    function getDocumentJson() {
      return JSON.stringify(documentState);
    }

    function syncSession() {
      rebaseDocumentOnAppliedPreferences();
      setAppliedPreferences(documentState);
    }

    function updateDirtyTracking() {
      return getDocumentJson() !== lastSavedJson;
    }

    function setDocument(nextDocument) {
      documentState = normalisePreferences(nextDocument);
      syncSession();
      return cloneJson(documentState);
    }

    function getDocument() {
      return cloneJson(documentState);
    }

    function getPagePreferences() {
      rebaseDocumentOnAppliedPreferences();
      return cloneJson(isPlainObject(documentState[normalisedPageKey]) ? documentState[normalisedPageKey] : {});
    }

    function replacePagePreferences(nextValue) {
      const nextPage = isPlainObject(nextValue) ? cloneJson(nextValue) : {};
      const nextDocument = {
        ...documentState,
        [normalisedPageKey]: nextPage
      };
      setDocument(nextDocument);
      return getPagePreferences();
    }

    function patchPagePreferences(partialValue) {
      const partial = isPlainObject(partialValue) ? partialValue : {};
      return replacePagePreferences({
        ...getPagePreferences(),
        ...partial
      });
    }

    async function flush({ keepalive = false, useBeacon = false } = {}) {
      if (flushPromise) return flushPromise;
      rebaseDocumentOnAppliedPreferences();
      if (!updateDirtyTracking()) return false;

      const snapshot = getDocument();
      const snapshotJson = JSON.stringify(snapshot);
      if (!getToken()) return false;

      const payload = { preferences: snapshot };
      flushPromise = (async () => {
        let saved = false;
        try {
          if (!saved) {
            const response = await authenticatedFetch(PREFERENCES_API, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify(payload),
              keepalive: Boolean(keepalive)
            });
            saved = response.ok;
          }
        } catch (_error) {
          saved = false;
        }

        if (saved) {
          lastSavedJson = snapshotJson;
        }

        return saved;
      })();

      try {
        return await flushPromise;
      } finally {
        flushPromise = null;
      }
    }

    const saveTimer = global.setInterval(() => {
      void flush();
    }, Math.max(30000, Number(saveIntervalMs) || PREFERENCE_SAVE_MS));

    function handleVisibilityChange() {
      if (global.document.visibilityState === "hidden") {
        void flush({ keepalive: true, useBeacon: true });
      }
    }

    function handlePageHide() {
      void flush({ keepalive: true, useBeacon: true });
    }

    function handleSessionEvent(event) {
      const nextPreferences = normalisePreferences(event?.detail?.user?.preferences);
      if (!updateDirtyTracking()) {
        documentState = nextPreferences;
        lastSavedJson = JSON.stringify(documentState);
        return;
      }

      rebaseDocumentOnAppliedPreferences();
    }

    global.addEventListener(SESSION_EVENT, handleSessionEvent);
    global.document.addEventListener("visibilitychange", handleVisibilityChange);
    global.addEventListener("pagehide", handlePageHide);

    const controller = {
      getDocument,
      getPagePreferences,
      replacePagePreferences,
      patchPagePreferences,
      flush,
      isDirty: updateDirtyTracking,
      destroy() {
        preferenceControllers.delete(controller);
        global.clearInterval(saveTimer);
        global.removeEventListener(SESSION_EVENT, handleSessionEvent);
        global.document.removeEventListener("visibilitychange", handleVisibilityChange);
        global.removeEventListener("pagehide", handlePageHide);
      }
    };
    preferenceControllers.add(controller);
    return controller;
  }

  global.AppAuth = {
    API,
    STORAGE_KEY,
    LAST_VIEW_KEY,
    LOGOUT_KEY,
    KIOSK_KEY,
    SESSION_EVENT,
    SESSION_REFRESH_MS,
    VIEWS,
    ACCESS_LABELS,
    normaliseUser,
    getSharedSession,
    getKioskSession,
    saveSharedSession,
    saveKioskSession,
    clearSharedSession,
    clearAllSessions,
    clearKioskSession,
    refreshSession,
    validateSession,
    hasRole,
    hasPermission,
    canAccess,
    hasViewAccess,
    getAccessLabels,
    describeAccess,
    rememberView,
    resolveLandingPath,
    applyAccessState,
    redirectToLogin,
    protectPage,
    startSlideshowKiosk,
    getToken,
    authenticatedFetch,
    logout,
    getAppliedPreferences,
    setAppliedPreferences,
    createPreferenceController,
    PREFERENCES_API,
    PREFERENCE_SAVE_MS
  };
})(window);
