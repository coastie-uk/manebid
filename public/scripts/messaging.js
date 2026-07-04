(function initOperatorMessaging(global) {
  "use strict";

  const API = "/api";
  const DEFAULT_CLOSED_POLL_MS = 30000;
  const ALL_USERS = "__all__";
  const config = {
    closedPollMs: DEFAULT_CLOSED_POLL_MS,
    enableItemReferences: true,
    auctionSelectId: "auction-select",
    ...(global.AppMessagingConfig || {})
  };

  const state = {
    token: null,
    currentUser: null,
    users: [],
    selectedUser: null,
    open: false,
    enabled: true,
    maxChars: 500,
    openPollMs: 3000,
    closedTimer: null,
    openTimer: null,
    statusInFlight: false,
    refreshInFlight: false,
    lastAutoOpenedAttentionKey: null,
    lastNotifiedUnreadKey: null,
    originalTitle: document.title,
    messageNotifications: false,
    preferenceController: null
  };

  const els = {};
  const itemReferencePattern = /^\s*(.*?)\s*\[item:(\d+):(\d+)\]\s*$/;

  function getToken() {
    return global.AppAuth?.getToken?.() || "";
  }

  function currentAuctionId() {
    if (typeof config.getAuctionId === "function") {
      const value = config.getAuctionId();
      const numeric = Number(value);
      return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
    }
    const select = document.getElementById(config.auctionSelectId || "auction-select");
    const numeric = Number(select?.value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  function request(path, options = {}) {
    return window.AppAuth.authenticatedFetch(`${API}${path}`, {
      ...options,
      headers: {
        "X-CSRF-Token": state.token,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    });
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    });
  }

  function formatRelativeLastSeen(value) {
    const parsed = Date.parse(value || "");
    if (Number.isNaN(parsed)) return "not seen recently";
    const minutes = Math.max(0, Math.floor((Date.now() - parsed) / 60000));
    if (minutes < 1) return "seen just now";
    if (minutes < 60) return `seen ${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `seen ${hours} hr ago`;
    const days = Math.floor(hours / 24);
    return `seen ${days} day${days === 1 ? "" : "s"} ago`;
  }

  function setHidden(element, hidden) {
    if (element) element.hidden = Boolean(hidden);
  }

  function setStatus(message, type = "info") {
    if (!els.status) return;
    els.status.textContent = message || "";
    els.status.dataset.type = type;
    els.status.hidden = !message;
  }

  function closeItemPanel({ clear = false } = {}) {
    setHidden(els.itemPanel, true);
    if (!clear) return;
    if (els.itemSearch) els.itemSearch.value = "";
    if (els.itemResults) els.itemResults.innerHTML = "";
  }

  function userSortTime(user) {
    const parsed = Date.parse(user.last_received_at || "");
    return Number.isNaN(parsed) ? 0 : parsed;
  }

  function sortUsers(users) {
    return users.slice().sort((a, b) => (
      userSortTime(b) - userSortTime(a)
      || String(a.username || "").localeCompare(String(b.username || ""))
    ));
  }

  function selectedAllUsers() {
    return state.selectedUser === ALL_USERS;
  }

  function setUnreadState(total) {
    const unread = Number(total || 0);
    document.title = unread > 0 ? `(${unread > 99 ? "99+" : unread}) ${state.originalTitle}` : state.originalTitle;
    if (!els.button || !els.badge) return;
    els.button.classList.toggle("has-unread", unread > 0);
    els.badge.hidden = unread <= 0;
    els.badge.textContent = unread > 99 ? "99+" : String(unread);
    els.button.title = unread > 0 ? `${unread} unread message${unread === 1 ? "" : "s"}` : "Messages";
    els.button.setAttribute("aria-label", els.button.title);
  }

  function notificationsSupported() {
    return "Notification" in global && typeof global.Notification?.requestPermission === "function";
  }

  function saveMessageNotificationPreference(enabled) {
    state.messageNotifications = enabled === true;
    state.preferenceController?.patchPagePreferences?.({
      message_notifications: state.messageNotifications,
      attention_notifications: state.messageNotifications
    });
    void state.preferenceController?.flush?.();
  }

  function syncNotificationToggle() {
    if (!els.notifications) return;
    els.notifications.checked = state.messageNotifications;
    els.notifications.disabled = !notificationsSupported();
    if (els.notificationsLabel) {
      els.notificationsLabel.title = notificationsSupported()
        ? "Notify for unread messages when this page is not focused"
        : "Browser notifications are not supported here";
    }
  }

  async function toggleMessageNotifications() {
    if (!els.notifications) return;
    if (!els.notifications.checked) {
      saveMessageNotificationPreference(false);
      setStatus("Message notifications disabled.");
      return;
    }
    if (!notificationsSupported()) {
      els.notifications.checked = false;
      setStatus("Browser notifications are not supported here.", "error");
      return;
    }
    const permission = await global.Notification.requestPermission();
    if (permission !== "granted") {
      els.notifications.checked = false;
      saveMessageNotificationPreference(false);
      setStatus("Browser notification permission was not granted.", "error");
      return;
    }
    saveMessageNotificationPreference(true);
    setStatus("Message notifications enabled.");
  }

  function attentionStatusKey(data = {}) {
    const sender = String(data.latest_attention_from || "");
    const id = Number(data.latest_attention_id);
    if (!sender) return null;
    return Number.isInteger(id) && id > 0
      ? `${sender}:${id}`
      : `${sender}:legacy`;
  }

  function unreadStatusKey(data = {}) {
    const sender = String(data.latest_unread_from || "");
    const id = Number(data.latest_unread_id);
    if (!sender) return null;
    return Number.isInteger(id) && id > 0
      ? `${sender}:${id}`
      : `${sender}:legacy`;
  }

  function createButton() {
    const target = document.querySelector(config.buttonContainerSelector || ".top-bar-status");
    if (!target || document.getElementById("operator-messaging-button")) return false;

    const button = document.createElement("button");
    button.id = "operator-messaging-button";
    button.type = "button";
    button.className = "messaging-button";
    button.title = "Messages";
    button.setAttribute("aria-label", "Messages");
    button.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M4 5h16v14H4z"></path>
        <path d="m4 7 8 6 8-6"></path>
      </svg>
      <span class="messaging-badge" hidden>0</span>
    `;
    target.appendChild(button);
    els.button = button;
    els.badge = button.querySelector(".messaging-badge");
    button.addEventListener("click", () => { void openModal(); });
    return true;
  }

  function createModal() {
    if (document.getElementById("operator-messaging-modal")) return;

    const modal = document.createElement("div");
    modal.id = "operator-messaging-modal";
    modal.className = "app-modal messaging-modal";
    modal.hidden = true;
    modal.innerHTML = `
      <div class="app-modal-card app-modal-card--messaging" role="dialog" aria-modal="true" aria-labelledby="operator-messaging-title">
        <div class="app-modal-header messaging-modal-header">
          <div>
            <h3 id="operator-messaging-title">Messages</h3>
            <p>Send short messages to other operators.</p>
          </div>
          <button id="operator-messaging-close" type="button" class="app-modal-close" aria-label="Close messages dialog">Close</button>
        </div>
        <div class="messaging-shell">
          <aside class="messaging-users" aria-label="Message recipients">
            <div class="messaging-users-head">Users</div>
            <div id="operator-messaging-users" class="messaging-user-list"></div>
          </aside>
          <section class="messaging-thread-panel" aria-live="polite">
            <div id="operator-messaging-thread-head" class="messaging-thread-head">Select a user</div>
            <div id="operator-messaging-thread" class="messaging-thread"></div>
            <div id="operator-messaging-item-panel" class="messaging-item-panel" hidden>
              <div class="messaging-item-search-row">
                <input id="operator-messaging-item-search" type="search" placeholder="Search current auction items">
                <button id="operator-messaging-item-search-button" type="button">Search</button>
              </div>
              <div id="operator-messaging-item-results" class="messaging-item-results"></div>
            </div>
            <div class="messaging-compose">
              <textarea id="operator-messaging-body" rows="3" placeholder="Type a message"></textarea>
              <label class="messaging-attention-toggle">
                <input id="operator-messaging-attention" type="checkbox">
                <span>Pop up on recipient screen</span>
              </label>
              <label id="operator-messaging-notifications-label" class="messaging-attention-toggle">
                <input id="operator-messaging-notifications" type="checkbox">
                <span>Browser notifications for unread messages</span>
              </label>
              <div class="messaging-compose-actions">
                <span id="operator-messaging-count" class="messaging-count">0 / 500</span>
                <button id="operator-messaging-insert-item" type="button">Insert item</button>
                <button id="operator-messaging-send" type="button">Send</button>
              </div>
              <div id="operator-messaging-status" class="messaging-status" hidden></div>
            </div>
          </section>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    els.modal = modal;
    els.close = modal.querySelector("#operator-messaging-close");
    els.userList = modal.querySelector("#operator-messaging-users");
    els.threadHead = modal.querySelector("#operator-messaging-thread-head");
    els.thread = modal.querySelector("#operator-messaging-thread");
    els.body = modal.querySelector("#operator-messaging-body");
    els.attention = modal.querySelector("#operator-messaging-attention");
    els.attentionWrap = modal.querySelector(".messaging-attention-toggle");
    els.notifications = modal.querySelector("#operator-messaging-notifications");
    els.notificationsLabel = modal.querySelector("#operator-messaging-notifications-label");
    els.send = modal.querySelector("#operator-messaging-send");
    els.count = modal.querySelector("#operator-messaging-count");
    els.status = modal.querySelector("#operator-messaging-status");
    els.insertItem = modal.querySelector("#operator-messaging-insert-item");
    els.itemPanel = modal.querySelector("#operator-messaging-item-panel");
    els.itemSearch = modal.querySelector("#operator-messaging-item-search");
    els.itemSearchButton = modal.querySelector("#operator-messaging-item-search-button");
    els.itemResults = modal.querySelector("#operator-messaging-item-results");

    els.close.addEventListener("click", closeModal);
    els.modal.addEventListener("click", (event) => {
      if (event.target === els.modal) closeModal();
    });
    els.send.addEventListener("click", sendCurrentMessage);
    els.notifications.addEventListener("change", () => { void toggleMessageNotifications(); });
    els.body.addEventListener("input", updateCharCount);
    els.body.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        sendCurrentMessage();
      }
    });
    els.insertItem.addEventListener("click", toggleItemPanel);
    els.itemSearchButton.addEventListener("click", searchItems);
    els.itemSearch.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        searchItems();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && state.open) closeModal();
    });
  }

  function updateCharCount() {
    const length = Array.from(els.body?.value || "").length;
    if (els.count) els.count.textContent = `${length} / ${state.maxChars}`;
    if (els.body) els.body.classList.toggle("is-over-limit", length > state.maxChars);
  }

  function itemReferencesEnabled() {
    return config.enableItemReferences !== false;
  }

  function renderMessageBody(container, text) {
    const lines = String(text || "").split("\n");
    lines.forEach((line, index) => {
      if (index > 0) container.appendChild(document.createTextNode("\n"));
      const match = line.match(itemReferencePattern);
      if (!match) {
        container.appendChild(document.createTextNode(line));
        return;
      }

      const label = match[1] || "Item reference";
      const auctionId = Number(match[2]);
      const itemId = Number(match[3]);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "messaging-item-link";
      button.textContent = label;
      button.addEventListener("click", () => jumpToItemReference({ auctionId, itemId }));
      container.appendChild(button);
    });
  }

  function jumpToItemReference({ auctionId, itemId }) {
    const hook = global.AppItems?.jumpToItem;
    if (typeof hook !== "function") {
      setStatus("Item links can be opened from Manage Items.", "info");
      return;
    }
    const result = hook({ auctionId, itemId }) || {};
    if (result.ok === false && result.message) {
      setStatus(result.message, "error");
      return;
    }
    setStatus("");
  }

  function renderUsers() {
    if (!els.userList) return;
    els.userList.innerHTML = "";

    if (!state.users.length) {
      const empty = document.createElement("div");
      empty.className = "messaging-empty";
      empty.textContent = "No other users are available.";
      els.userList.appendChild(empty);
      return;
    }

    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.className = "messaging-user-button messaging-user-button--all";
    allButton.classList.toggle("is-active", selectedAllUsers());
    allButton.dataset.username = ALL_USERS;

    const allMain = document.createElement("span");
    allMain.className = "messaging-user-main";
    const allIcon = document.createElement("span");
    allIcon.className = "messaging-broadcast-dot";
    allIcon.textContent = "All";
    const allName = document.createElement("span");
    allName.className = "messaging-user-name";
    allName.textContent = "[All users]";
    allMain.append(allIcon, allName);
    allButton.appendChild(allMain);
    allButton.addEventListener("click", () => selectUser(ALL_USERS));
    els.userList.appendChild(allButton);

    sortUsers(state.users).forEach((user) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "messaging-user-button";
      button.classList.toggle("is-active", user.username === state.selectedUser);
      button.dataset.username = user.username;

      const main = document.createElement("span");
      main.className = "messaging-user-main";

      const dot = document.createElement("span");
      dot.className = `messaging-presence-dot ${user.online ? "is-online" : ""}`;
      dot.title = user.online ? "Logged in recently" : "Not seen recently";

      const name = document.createElement("span");
      name.className = "messaging-user-name";
      name.textContent = user.username;
      const presenceText = document.createElement("span");
      presenceText.className = "messaging-user-presence";
      presenceText.textContent = user.online ? "online" : formatRelativeLastSeen(user.last_seen_at);
      presenceText.title = user.last_seen_at ? new Date(user.last_seen_at).toLocaleString() : presenceText.textContent;

      const details = document.createElement("span");
      details.className = "messaging-user-details";
      details.append(name, presenceText);
      main.append(dot, details);
      button.appendChild(main);

      if (Number(user.unread_count) > 0) {
        const unread = document.createElement("span");
        unread.className = "messaging-user-unread";
        unread.textContent = String(user.unread_count);
        button.appendChild(unread);
      }

      button.addEventListener("click", () => selectUser(user.username));
      els.userList.appendChild(button);
    });
  }

  function renderThread(messages) {
    if (!els.thread) return;
    els.thread.innerHTML = "";

    if (!state.selectedUser) {
      els.threadHead.textContent = "Select a user";
      setHidden(els.body, true);
      setHidden(els.attentionWrap, true);
      setHidden(els.send, true);
      setHidden(els.insertItem, true);
      closeItemPanel({ clear: true });
      return;
    }

    els.threadHead.textContent = selectedAllUsers() ? "Message all users" : `Conversation with ${state.selectedUser}`;
    setHidden(els.body, false);
    setHidden(els.attentionWrap, false);
    setHidden(els.send, false);
    setHidden(els.insertItem, !itemReferencesEnabled());
    if (!itemReferencesEnabled()) closeItemPanel({ clear: true });

    if (selectedAllUsers()) {
      const empty = document.createElement("div");
      empty.className = "messaging-empty";
      empty.textContent = "Messages sent here are copied into each user's conversation.";
      els.thread.appendChild(empty);
      return;
    }

    if (!messages.length) {
      const empty = document.createElement("div");
      empty.className = "messaging-empty";
      empty.textContent = "No messages yet.";
      els.thread.appendChild(empty);
      return;
    }

    messages.forEach((message) => {
      const bubble = document.createElement("article");
      bubble.className = `messaging-message is-${message.direction}`;
      bubble.classList.toggle("is-attention", message.attention === true);

      const body = document.createElement("div");
      body.className = "messaging-message-body";
      renderMessageBody(body, message.body);

      const meta = document.createElement("div");
      meta.className = "messaging-message-meta";
      const broadcastText = message.broadcast ? " · Sent to everyone" : "";
      const attentionText = message.attention ? " · Attention" : "";
      const readText = message.direction === "outgoing"
        ? (message.read_at ? ` · Read ${formatTime(message.read_at)}` : " · Sent")
        : "";
      const acknowledgedText = message.attention && message.acknowledged_at
        ? ` · Acknowledged ${formatTime(message.acknowledged_at)}`
        : "";
      meta.textContent = `${formatDateTime(message.created_at)}${broadcastText}${attentionText}${readText}${acknowledgedText}`;

      bubble.append(body, meta);
      if (message.direction === "incoming" && message.acknowledgement_required === true) {
        const acknowledge = document.createElement("button");
        acknowledge.type = "button";
        acknowledge.className = "messaging-acknowledge";
        acknowledge.textContent = "Acknowledge";
        acknowledge.addEventListener("click", () => { void acknowledgeAttentionMessage(message.id, acknowledge); });
        bubble.appendChild(acknowledge);
      }
      els.thread.appendChild(bubble);
    });

    els.thread.scrollTop = els.thread.scrollHeight;
  }

  async function fetchStatus() {
    if (!state.token || state.statusInFlight) return;
    state.statusInFlight = true;
    try {
      const res = await request("/messages/status");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      state.enabled = data.enabled !== false;
      state.maxChars = Number(data.config?.max_message_chars || state.maxChars || 500);
      state.openPollMs = Number(data.config?.open_poll_ms || state.openPollMs || 3000);
      setUnreadState(data.unread_total || 0);
      if (!state.enabled && els.button) els.button.hidden = true;
      updateCharCount();
      const attentionKey = attentionStatusKey(data);
      maybeNotifyUnread(data, unreadStatusKey(data));
      if (
        !state.open
        && document.visibilityState === "visible"
        && data.latest_attention_from
        && attentionKey !== state.lastAutoOpenedAttentionKey
      ) {
        state.lastAutoOpenedAttentionKey = attentionKey;
        void openModal({ selectedUser: data.latest_attention_from });
      }
    } finally {
      state.statusInFlight = false;
    }
  }

  function maybeNotifyUnread(data, unreadKey) {
    if (
      !unreadKey
      || !state.messageNotifications
      || !notificationsSupported()
      || global.Notification.permission !== "granted"
      || unreadKey === state.lastNotifiedUnreadKey
      || (document.visibilityState === "visible" && document.hasFocus())
    ) {
      return;
    }

    const attention = data.latest_unread_attention === true;
    const preview = String(data.latest_unread_body || "").trim();
    const notification = new global.Notification(attention ? "Attention message" : "New message", {
      body: preview
        ? `${data.latest_unread_from}: ${preview}`
        : `${data.latest_unread_from} sent a ${attention ? "high priority " : ""}message.`,
      tag: `operator-message-${unreadKey}`
    });
    state.lastNotifiedUnreadKey = unreadKey;
    notification.onclick = () => {
      global.focus();
      void openModal({ selectedUser: data.latest_unread_from });
      notification.close();
    };
  }

  async function fetchUsers() {
    const res = await request("/messages/users");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Unable to load users");
    state.users = sortUsers(Array.isArray(data.users) ? data.users : []);
    state.currentUser = data.current_user || state.currentUser;
    if (state.selectedUser && !selectedAllUsers() && !state.users.some((user) => user.username === state.selectedUser)) {
      state.selectedUser = null;
    }
    renderUsers();
  }

  async function fetchThread() {
    if (!state.selectedUser) {
      renderThread([]);
      return;
    }
    if (selectedAllUsers()) {
      renderThread([]);
      return;
    }
    const res = await request(`/messages/thread/${encodeURIComponent(state.selectedUser)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Unable to load conversation");
    renderThread(Array.isArray(data.messages) ? data.messages : []);
    setUnreadState(data.unread_total || 0);
  }

  async function refreshOpenModal({ keepStatus = true } = {}) {
    if (!state.open || state.refreshInFlight) return;
    state.refreshInFlight = true;
    try {
      if (!keepStatus) setStatus("");
      await fetchUsers();
      await fetchThread();
    } catch (error) {
      setStatus(error.message || "Unable to refresh messages", "error");
    } finally {
      state.refreshInFlight = false;
    }
  }

  async function acknowledgeAttentionMessage(id, button) {
    if (button) button.disabled = true;
    try {
      const res = await request(`/messages/${encodeURIComponent(id)}/acknowledge`, {
        method: "POST",
        body: JSON.stringify({})
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Unable to acknowledge message");
      setUnreadState(data.unread_total || 0);
      await fetchThread();
    } catch (error) {
      setStatus(error.message || "Unable to acknowledge message", "error");
      if (button) button.disabled = false;
    }
  }

  function startClosedPolling() {
    if (state.closedTimer) global.clearInterval(state.closedTimer);
    const interval = Math.max(5000, Number(config.closedPollMs || DEFAULT_CLOSED_POLL_MS));
    state.closedTimer = global.setInterval(() => {
      if (!state.open) {
        void fetchStatus();
      }
    }, interval);
  }

  function startOpenPolling() {
    if (state.openTimer) global.clearInterval(state.openTimer);
    state.openTimer = global.setInterval(() => {
      if (!state.open) return;
      if (document.visibilityState === "visible") {
        void refreshOpenModal();
      } else {
        void fetchStatus();
      }
    }, Math.max(1000, Number(state.openPollMs || 3000)));
  }

  function stopOpenPolling() {
    if (!state.openTimer) return;
    global.clearInterval(state.openTimer);
    state.openTimer = null;
  }

  async function openModal(options = {}) {
    if (!state.enabled) return;
    const selectedUser = options && typeof options === "object" && options.selectedUser
      ? String(options.selectedUser)
      : null;
    if (selectedUser) state.selectedUser = selectedUser;
    state.open = true;
    setStatus("");
    els.modal.hidden = false;
    await refreshOpenModal({ keepStatus: false });
    startOpenPolling();
    els.body?.focus();
  }

  function closeModal() {
    state.open = false;
    closeItemPanel({ clear: true });
    els.modal.hidden = true;
    stopOpenPolling();
    void fetchStatus();
  }

  async function selectUser(username) {
    state.selectedUser = username;
    renderUsers();
    setStatus("");
    await fetchThread().catch((error) => setStatus(error.message, "error"));
    els.body?.focus();
  }

  async function sendCurrentMessage() {
    if (!state.selectedUser) {
      setStatus("Choose a user first.", "error");
      return;
    }
    const body = els.body?.value || "";
    if (Array.from(body.trim()).length > state.maxChars) {
      setStatus(`Message must be ${state.maxChars} characters or fewer.`, "error");
      return;
    }

    els.send.disabled = true;
    try {
      const res = await request("/messages", {
        method: "POST",
        body: JSON.stringify({
          to: state.selectedUser,
          body,
          attention: els.attention?.checked === true
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Unable to send message");
      els.body.value = "";
      if (els.attention) els.attention.checked = false;
      updateCharCount();
      setStatus(data.broadcast ? `Sent to ${data.recipient_count || 0} users.` : "");
      await refreshOpenModal();
    } catch (error) {
      setStatus(error.message || "Unable to send message", "error");
    } finally {
      els.send.disabled = false;
      els.body?.focus();
    }
  }

  function toggleItemPanel() {
    if (!itemReferencesEnabled()) return;
    const auctionId = currentAuctionId();
    if (!auctionId) {
      setStatus("Select an auction before inserting an item reference.", "error");
      return;
    }
    els.itemPanel.hidden = !els.itemPanel.hidden;
    if (!els.itemPanel.hidden) {
      els.itemSearch.value = "";
      els.itemResults.innerHTML = "";
      els.itemSearch.focus();
    }
  }

  async function searchItems() {
    const auctionId = currentAuctionId();
    if (!auctionId) {
      setStatus("Select an auction before searching items.", "error");
      return;
    }

    els.itemResults.innerHTML = "";
    const loading = document.createElement("div");
    loading.className = "messaging-empty";
    loading.textContent = "Searching...";
    els.itemResults.appendChild(loading);

    try {
      const params = new URLSearchParams({ auction_id: String(auctionId) });
      const query = String(els.itemSearch.value || "").trim();
      if (query) params.set("q", query);
      const res = await request(`/messages/items?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Unable to search items");
      renderItemResults(Array.isArray(data.items) ? data.items : []);
    } catch (error) {
      els.itemResults.innerHTML = "";
      const failed = document.createElement("div");
      failed.className = "messaging-empty";
      failed.textContent = error.message || "Unable to search items";
      els.itemResults.appendChild(failed);
    }
  }

  function renderItemResults(items) {
    els.itemResults.innerHTML = "";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "messaging-empty";
      empty.textContent = "No matching items.";
      els.itemResults.appendChild(empty);
      return;
    }

    items.forEach((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "messaging-item-result";
      const referenceText = item.reference_text || "Item reference";
      button.textContent = referenceText.replace(/\s*\[item:\d+:\d+\]\s*$/, "");
      button.addEventListener("click", () => {
        const insertion = referenceText;
        const prefix = els.body.value && !els.body.value.endsWith("\n") ? "\n" : "";
        els.body.value = `${els.body.value}${prefix}${insertion}`;
        updateCharCount();
        closeItemPanel({ clear: true });
        els.body.focus();
      });
      els.itemResults.appendChild(button);
    });
  }

  async function start() {
    const session = global.__APP_AUTH_READY__
      ? await global.__APP_AUTH_READY__
      : (global.__APP_AUTH_BOOTSTRAP__ || null);
    state.token = session?.csrf_token || getToken();
    if (!state.token) return;
    if (!createButton()) return;
    createModal();
    state.preferenceController = global.AppAuth?.createPreferenceController?.({ pageKey: "messaging" }) || null;
    const messagingPreferences = state.preferenceController?.getPagePreferences?.() || {};
    state.messageNotifications = messagingPreferences.message_notifications === true
      || messagingPreferences.attention_notifications === true;
    syncNotificationToggle();
    await fetchStatus();
    if (!state.enabled) return;
    startClosedPolling();
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        if (state.open) {
          void refreshOpenModal();
        } else {
          void fetchStatus();
        }
      }
    });
  }

  global.AppMessaging = {
    refreshStatus: fetchStatus
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { void start(); });
  } else {
    void start();
  }
})(window);
