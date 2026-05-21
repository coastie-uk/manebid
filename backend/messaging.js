/**
 * @file        messaging.js
 * @description In-memory operator messaging service and route handlers.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Parser } = require("@json2csv/plainjs");
const db = require("./db");
const { log, logLevels } = require("./logger");
const { sanitiseText } = require("./middleware/sanitiseText");
const {
  MESSAGING_ENABLED,
  MESSAGING_MAX_MESSAGES,
  MESSAGING_MAX_CACHE_BYTES,
  MESSAGING_MAX_MESSAGE_CHARS,
  MESSAGING_OPEN_POLL_MS,
  MESSAGING_PRESENCE_TTL_MS,
  MESSAGING_PERSISTENCE_FILE
} = require("./config");
const {
  listUsers,
  getUserByUsername,
  normaliseUsername,
  isValidUsername,
  shapeUserAccess
} = require("./users");

const OPERATOR_ROLES = new Set(["admin", "maintenance", "cashier"]);
const OPERATOR_PERMISSIONS = new Set(["live_feed"]);
const ACTIVE_ITEM_WHERE = "COALESCE(is_deleted, 0) = 0";
const BROADCAST_RECIPIENT = "__all__";
const PERSISTENCE_FORMAT_VERSION = 1;
const PERSISTENCE_FLUSH_MS = 60000;

let nextMessageId = 1;
let messages = [];
const presence = new Map();
let persistenceDirty = false;
let persistenceLoaded = false;
let persistenceLastLoadedAt = null;
let persistenceLastSavedAt = null;
let persistenceLastError = null;
let persistenceTimer = null;

function getDatabaseId() {
  return db.getMetadataValue("database_id") || "";
}

function getPersistencePath() {
  return path.resolve(MESSAGING_PERSISTENCE_FILE);
}

function logPersistence(level, message) {
  log("Messaging", level, message);
}

function getPayloadForChecksum(nextId = nextMessageId, messageList = messages) {
  return {
    next_message_id: nextId,
    messages: messageList
  };
}

function checksumPayload(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}

function buildPersistenceDocument({ createdAt = null } = {}) {
  const now = new Date().toISOString();
  const payload = getPayloadForChecksum();
  return {
    format_version: PERSISTENCE_FORMAT_VERSION,
    created_at: createdAt || now,
    updated_at: now,
    database_id: getDatabaseId(),
    payload_checksum: checksumPayload(payload),
    message_count: messages.length,
    next_message_id: nextMessageId,
    messages
  };
}

function sanitizeLoadedMessage(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = Number(raw.id);
  const from = normaliseUsername(raw.from || "");
  const to = normaliseUsername(raw.to || "");
  const body = normalizeBody(raw.body || "");
  const createdAt = typeof raw.created_at === "string" && raw.created_at ? raw.created_at : null;
  const createdAtMs = Number(raw.created_at_ms);

  if (!Number.isInteger(id) || id <= 0 || !from || !to || !body || !createdAt || !Number.isFinite(createdAtMs)) {
    return null;
  }

  const readBy = {};
  if (raw.read_by && typeof raw.read_by === "object" && !Array.isArray(raw.read_by)) {
    Object.entries(raw.read_by).forEach(([username, readAt]) => {
      const normalized = normaliseUsername(username);
      if (normalized && typeof readAt === "string" && readAt) {
        readBy[normalized] = readAt;
      }
    });
  }

  return {
    id,
    from,
    to,
    body,
    created_at: createdAt,
    created_at_ms: createdAtMs,
    broadcast: raw.broadcast === true,
    broadcast_id: typeof raw.broadcast_id === "string" && raw.broadcast_id ? raw.broadcast_id : null,
    attention: raw.attention === true,
    read_by: readBy
  };
}

function quarantinePersistenceFile(reason) {
  const filePath = getPersistencePath();
  const parsed = path.parse(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let target = path.join(parsed.dir, `${parsed.name}.${reason}.${stamp}${parsed.ext || ".json"}`);
  let suffix = 1;
  while (fs.existsSync(target)) {
    target = path.join(parsed.dir, `${parsed.name}.${reason}.${stamp}.${suffix}${parsed.ext || ".json"}`);
    suffix += 1;
  }
  fs.renameSync(filePath, target);
  return target;
}

function writePersistenceFile() {
  const filePath = getPersistencePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const currentDoc = fs.existsSync(filePath)
    ? (() => {
        try {
          return JSON.parse(fs.readFileSync(filePath, "utf8"));
        } catch (_error) {
          return null;
        }
      })()
    : null;
  const document = buildPersistenceDocument({
    createdAt: typeof currentDoc?.created_at === "string" ? currentDoc.created_at : null
  });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  persistenceDirty = false;
  persistenceLastSavedAt = document.updated_at;
  persistenceLastError = null;
  return document;
}

function markPersistenceDirty() {
  persistenceDirty = true;
}

function flushPersistence({ force = false } = {}) {
  if (!force && !persistenceDirty) return;
  try {
    const document = writePersistenceFile();
    logPersistence(logLevels.DEBUG, `Saved ${document.message_count} operator messages to ${getPersistencePath()}`);
  } catch (error) {
    persistenceLastError = error.message;
    logPersistence(logLevels.ERROR, `Failed to save operator messages to ${getPersistencePath()}: ${error.message}`);
  }
}

function createEmptyPersistenceFile() {
  messages = [];
  nextMessageId = 1;
  persistenceDirty = true;
  flushPersistence({ force: true });
}

function initialisePersistence() {
  const filePath = getPersistencePath();
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    if (!fs.existsSync(filePath)) {
      createEmptyPersistenceFile();
      persistenceLoaded = true;
      persistenceLastLoadedAt = new Date().toISOString();
      logPersistence(logLevels.INFO, `Created operator message persistence file at ${filePath}`);
      return;
    }

    const raw = fs.readFileSync(filePath, "utf8");
    const document = JSON.parse(raw);
    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("invalid_document");
    }
    if (document.format_version !== PERSISTENCE_FORMAT_VERSION) {
      throw new Error("format_version_mismatch");
    }
    if (document.database_id !== getDatabaseId()) {
      throw new Error("database_id_mismatch");
    }

    const loadedMessages = Array.isArray(document.messages)
      ? document.messages.map(sanitizeLoadedMessage).filter(Boolean)
      : [];
    const storedNextId = Number(document.next_message_id);
    const checksum = checksumPayload({
      next_message_id: storedNextId,
      messages: document.messages
    });
    if (document.payload_checksum !== checksum) {
      throw new Error("payload_checksum_mismatch");
    }

    messages = loadedMessages;
    const maxLoadedId = messages.reduce((maxId, message) => Math.max(maxId, message.id), 0);
    nextMessageId = Number.isInteger(storedNextId) && storedNextId > maxLoadedId
      ? storedNextId
      : maxLoadedId + 1;
    const beforePruneCount = messages.length;
    const beforePruneBytes = estimateCacheBytes();
    pruneMessages({ markDirty: false });
    persistenceDirty = loadedMessages.length !== document.messages.length
      || messages.length !== beforePruneCount
      || estimateCacheBytes() !== beforePruneBytes
      || nextMessageId !== storedNextId;
    persistenceLoaded = true;
    persistenceLastLoadedAt = new Date().toISOString();
    persistenceLastError = null;
    logPersistence(logLevels.INFO, `Loaded ${messages.length} operator messages from ${filePath}`);
  } catch (error) {
    try {
      const reason = error.message && /^[a-z0-9_]+$/i.test(error.message) ? error.message : "invalid";
      const quarantinedPath = fs.existsSync(filePath) ? quarantinePersistenceFile(reason) : null;
      createEmptyPersistenceFile();
      persistenceLoaded = true;
      persistenceLastLoadedAt = new Date().toISOString();
      persistenceLastError = error.message;
      logPersistence(
        logLevels.WARN,
        `Operator message persistence file could not be loaded (${error.message}); ${quarantinedPath ? `renamed to ${quarantinedPath} and ` : ""}created a new file at ${filePath}`
      );
    } catch (recoveryError) {
      persistenceLastError = recoveryError.message;
      logPersistence(logLevels.ERROR, `Failed to initialise operator message persistence at ${filePath}: ${recoveryError.message}`);
    }
  }
}

function startPersistenceTimer() {
  if (persistenceTimer) return;
  persistenceTimer = setInterval(() => flushPersistence(), PERSISTENCE_FLUSH_MS);
  if (typeof persistenceTimer.unref === "function") {
    persistenceTimer.unref();
  }
}

function getPersistenceStatus() {
  return {
    file: getPersistencePath(),
    format_version: PERSISTENCE_FORMAT_VERSION,
    flush_interval_ms: PERSISTENCE_FLUSH_MS,
    loaded: persistenceLoaded,
    dirty: persistenceDirty,
    last_loaded_at: persistenceLastLoadedAt,
    last_saved_at: persistenceLastSavedAt,
    last_error: persistenceLastError,
    database_id: getDatabaseId()
  };
}

function isMessagingEnabled() {
  return MESSAGING_ENABLED === true;
}

function getConfigSummary() {
  return {
    enabled: isMessagingEnabled(),
    max_messages: MESSAGING_MAX_MESSAGES,
    max_cache_bytes: MESSAGING_MAX_CACHE_BYTES,
    max_message_chars: MESSAGING_MAX_MESSAGE_CHARS,
    open_poll_ms: MESSAGING_OPEN_POLL_MS,
    presence_ttl_ms: MESSAGING_PRESENCE_TTL_MS,
    persistence_file: getPersistencePath(),
    persistence_flush_ms: PERSISTENCE_FLUSH_MS
  };
}

function getActorUsername(req) {
  return normaliseUsername(req.user?.username || "");
}

function userCanUseMessaging(user) {
  if (!user) return false;
  const access = shapeUserAccess(user);
  return access.roles.some((role) => OPERATOR_ROLES.has(role))
    || access.permissions.some((permission) => OPERATOR_PERMISSIONS.has(permission));
}

function getMessageableUsers() {
  return listUsers().filter(userCanUseMessaging);
}

function getMessageableUser(username) {
  const normalized = normaliseUsername(username);
  if (!normalized || !isValidUsername(normalized)) return null;
  const user = getUserByUsername(normalized);
  return userCanUseMessaging(user) ? user : null;
}

function touchPresence(username) {
  const normalized = normaliseUsername(username);
  if (!normalized) return null;
  const now = Date.now();
  presence.set(normalized, now);
  return now;
}

function getPresenceForUser(username) {
  const normalized = normaliseUsername(username);
  const lastSeenMs = presence.get(normalized) || 0;
  const online = lastSeenMs > 0 && Date.now() - lastSeenMs <= MESSAGING_PRESENCE_TTL_MS;
  return {
    online,
    last_seen_at: lastSeenMs ? new Date(lastSeenMs).toISOString() : null
  };
}

function normalizeBody(value) {
  if (typeof value !== "string") return "";
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  return sanitiseText(normalized, 0);
}

function charLength(value) {
  return Array.from(String(value || "")).length;
}

function estimateCacheBytes() {
  if (messages.length === 0) return 0;
  return Buffer.byteLength(JSON.stringify(messages), "utf8");
}

function pruneMessages({ markDirty = true } = {}) {
  const beforeLength = messages.length;
  const beforeBytes = estimateCacheBytes();
  while (messages.length > MESSAGING_MAX_MESSAGES) {
    messages.shift();
  }

  while (messages.length > 1 && estimateCacheBytes() > MESSAGING_MAX_CACHE_BYTES) {
    messages.shift();
  }

  if (markDirty && (messages.length !== beforeLength || estimateCacheBytes() !== beforeBytes)) {
    markPersistenceDirty();
  }
}

function countUnreadFor(username, fromUsername = null) {
  const normalized = normaliseUsername(username);
  const from = fromUsername ? normaliseUsername(fromUsername) : null;
  if (!normalized) return 0;

  return messages.reduce((count, message) => {
    if (message.to !== normalized) return count;
    if (from && message.from !== from) return count;
    return message.read_by?.[normalized] ? count : count + 1;
  }, 0);
}

function getUnreadByUser(username) {
  const normalized = normaliseUsername(username);
  const unread = {};
  if (!normalized) return unread;

  messages.forEach((message) => {
    if (message.to !== normalized || message.read_by?.[normalized]) return;
    unread[message.from] = (unread[message.from] || 0) + 1;
  });

  return unread;
}

function getUnreadAttentionFor(username) {
  const normalized = normaliseUsername(username);
  const unreadByUser = {};
  let latest = null;
  if (!normalized) {
    return {
      unread_attention_total: 0,
      unread_attention_by_user: unreadByUser,
      latest_attention_from: null,
      latest_attention_id: null
    };
  }

  messages.forEach((message) => {
    if (message.to !== normalized || message.attention !== true || message.read_by?.[normalized]) return;
    unreadByUser[message.from] = (unreadByUser[message.from] || 0) + 1;
    if (!latest || message.created_at_ms > latest.created_at_ms) {
      latest = message;
    }
  });

  return {
    unread_attention_total: Object.values(unreadByUser).reduce((sum, value) => sum + Number(value || 0), 0),
    unread_attention_by_user: unreadByUser,
    latest_attention_from: latest?.from || null,
    latest_attention_id: latest?.id || null
  };
}

function getLastReceivedAt(username, fromUsername) {
  const normalized = normaliseUsername(username);
  const from = normaliseUsername(fromUsername);
  let lastMessage = null;
  if (!normalized || !from) return { last_received_at: null, last_received_ms: 0 };

  messages.forEach((message) => {
    if (message.to !== normalized || message.from !== from) return;
    if (!lastMessage || message.created_at_ms > lastMessage.created_at_ms) {
      lastMessage = message;
    }
  });

  return {
    last_received_at: lastMessage?.created_at || null,
    last_received_ms: lastMessage?.created_at_ms || 0
  };
}

function buildMessageView(message, currentUser) {
  const current = normaliseUsername(currentUser);
  const other = message.from === current ? message.to : message.from;
  return {
    id: message.id,
    from: message.from,
    to: message.to,
    body: message.body,
    created_at: message.created_at,
    direction: message.from === current ? "outgoing" : "incoming",
    broadcast: message.broadcast === true,
    broadcast_id: message.broadcast_id || null,
    attention: message.attention === true,
    read_at: message.read_by?.[other] || null
  };
}

function ensureEnabled(res) {
  if (isMessagingEnabled()) return true;
  res.status(403).json({ error: "Messaging is disabled", enabled: false });
  return false;
}

function ensureActor(req, res) {
  const username = getActorUsername(req);
  const user = getMessageableUser(username);
  if (!user) {
    res.status(403).json({ error: "Messaging is not available for this user" });
    return null;
  }
  touchPresence(username);
  return username;
}

function getStatusFor(username) {
  const unreadByUser = getUnreadByUser(username);
  const attention = getUnreadAttentionFor(username);
  return {
    enabled: isMessagingEnabled(),
    unread_total: Object.values(unreadByUser).reduce((sum, value) => sum + Number(value || 0), 0),
    unread_by_user: unreadByUser,
    ...attention,
    config: getConfigSummary(),
    stats: getStats()
  };
}

function getStats() {
  return {
    enabled: isMessagingEnabled(),
    message_count: messages.length,
    estimated_bytes: estimateCacheBytes(),
    max_messages: MESSAGING_MAX_MESSAGES,
    max_cache_bytes: MESSAGING_MAX_CACHE_BYTES,
    max_message_chars: MESSAGING_MAX_MESSAGE_CHARS,
    open_poll_ms: MESSAGING_OPEN_POLL_MS,
    presence_ttl_ms: MESSAGING_PRESENCE_TTL_MS,
    persistence: getPersistenceStatus()
  };
}

function validateSendBody(from, body) {
  if (!from || !getMessageableUser(from)) {
    const error = new Error("sender_not_allowed");
    error.status = 403;
    throw error;
  }
  if (!body) {
    const error = new Error("empty_message");
    error.status = 400;
    throw error;
  }
  if (charLength(body) > MESSAGING_MAX_MESSAGE_CHARS) {
    const error = new Error("message_too_long");
    error.status = 400;
    throw error;
  }
}

function createMessage({ from, to, body, now, createdAt, broadcast = false, broadcastId = null, attention = false }) {
  const message = {
    id: nextMessageId++,
    from,
    to,
    body,
    created_at: createdAt,
    created_at_ms: now,
    broadcast,
    broadcast_id: broadcastId,
    attention,
    read_by: {
      [from]: createdAt
    }
  };

  messages.push(message);
  markPersistenceDirty();
  return message;
}

function sendMessage(fromUsername, toUsername, bodyValue, { attention = false } = {}) {
  const from = normaliseUsername(fromUsername);
  const to = normaliseUsername(toUsername);
  const body = normalizeBody(bodyValue);
  const needsAttention = attention === true;
  validateSendBody(from, body);

  if (to === BROADCAST_RECIPIENT) {
    const recipients = getMessageableUsers()
      .map((user) => normaliseUsername(user.username))
      .filter((username) => username && username !== from);

    if (!recipients.length) {
      const error = new Error("no_broadcast_recipients");
      error.status = 400;
      throw error;
    }

    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const broadcastId = `broadcast-${now}-${nextMessageId}`;
    const sentMessages = recipients.map((recipient) => createMessage({
      from,
      to: recipient,
      body,
      now,
      createdAt,
      broadcast: true,
      broadcastId,
      attention: needsAttention
    }));
    pruneMessages();
    markPersistenceDirty();
    return {
      broadcast: true,
      recipient_count: sentMessages.length,
      messages: sentMessages
    };
  }

  if (!to || !getMessageableUser(to)) {
    const error = new Error("recipient_not_found");
    error.status = 404;
    throw error;
  }
  if (from === to) {
    const error = new Error("cannot_message_self");
    error.status = 400;
    throw error;
  }

  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const message = createMessage({
    from,
    to,
    body,
    now,
    createdAt,
    attention: needsAttention
  });
  pruneMessages();
  markPersistenceDirty();
  return {
    broadcast: false,
    recipient_count: 1,
    messages: [message]
  };
}

function getThread(currentUsername, otherUsername, { markRead = true } = {}) {
  const current = normaliseUsername(currentUsername);
  const other = normaliseUsername(otherUsername);
  if (!current || !other) return [];

  if (markRead) {
    const readAt = new Date().toISOString();
    let changed = false;
    messages.forEach((message) => {
      if (message.to === current && message.from === other && !message.read_by?.[current]) {
        message.read_by = message.read_by || {};
        message.read_by[current] = readAt;
        changed = true;
      }
    });
    if (changed) markPersistenceDirty();
  }

  return messages
    .filter((message) => (
      (message.from === current && message.to === other)
      || (message.from === other && message.to === current)
    ))
    .sort((a, b) => a.created_at_ms - b.created_at_ms)
    .map((message) => buildMessageView(message, current));
}

function clearMessages() {
  const deleted = messages.length;
  messages = [];
  nextMessageId = 1;
  markPersistenceDirty();
  flushPersistence({ force: true });
  return {
    deleted,
    stats: getStats()
  };
}

function exportRows() {
  return messages
    .slice()
    .sort((a, b) => a.created_at_ms - b.created_at_ms)
    .map((message) => ({
      id: message.id,
      created_at: message.created_at,
      from: message.from,
      to: message.to,
      body: message.body,
      broadcast: message.broadcast === true ? "yes" : "no",
      broadcast_id: message.broadcast_id || "",
      attention: message.attention === true ? "yes" : "no",
      read_by: Object.keys(message.read_by || {}).sort().join("|"),
      read_at_recipient: message.read_by?.[message.to] || ""
    }));
}

function exportCsv() {
  const parser = new Parser({
    fields: ["id", "created_at", "from", "to", "body", "broadcast", "broadcast_id", "attention", "read_by", "read_at_recipient"]
  });
  return parser.parse(exportRows());
}

function buildItemReference(item, auctionId) {
  const auctionName = String(item.auction_name || item.auction_short_name || "Auction").trim();
  const itemLabel = item.item_number == null || item.item_number === ""
    ? "Unnumbered item"
    : `Item #${item.item_number}`;
  const description = String(item.description || "Untitled item").trim();
  return `${auctionName}: ${itemLabel}: ${description} [item:${auctionId}:${item.id}]`;
}

function searchItems({ auctionId, query }) {
  const aid = Number(auctionId);
  if (!Number.isInteger(aid) || aid <= 0) {
    const error = new Error("invalid_auction_id");
    error.status = 400;
    throw error;
  }

  const q = String(query || "").trim();
  const like = `%${q.replace(/[%_]/g, "\\$&")}%`;
  const params = q
    ? [aid, String(q), like, like, like]
    : [aid];
  const where = q
    ? `auction_id = ?
       AND ${ACTIVE_ITEM_WHERE}
       AND (
         CAST(item_number AS TEXT) = ?
         OR description LIKE ? ESCAPE '\\'
         OR contributor LIKE ? ESCAPE '\\'
         OR artist LIKE ? ESCAPE '\\'
       )`
    : `auction_id = ? AND ${ACTIVE_ITEM_WHERE}`;

  const rows = db.prepare(`
    SELECT items.id,
           items.item_number,
           items.description,
           items.contributor,
           items.artist,
           auctions.full_name AS auction_name,
           auctions.short_name AS auction_short_name
      FROM items
      JOIN auctions ON auctions.id = items.auction_id
     WHERE ${where}
     ORDER BY items.item_number ASC, items.id ASC
     LIMIT 25
  `).all(...params);

  return rows.map((item) => ({
    ...item,
    reference_text: buildItemReference(item, aid)
  }));
}

function handleStatus(req, res) {
  const username = getActorUsername(req);
  if (username) touchPresence(username);
  return res.json(getStatusFor(username));
}

function handleUsers(req, res) {
  if (!ensureEnabled(res)) return;
  const current = ensureActor(req, res);
  if (!current) return;

  const users = getMessageableUsers()
    .filter((user) => normaliseUsername(user.username) !== current)
    .map((user) => {
      const username = normaliseUsername(user.username);
      const lastReceived = getLastReceivedAt(current, username);
      return {
        username,
        roles: user.roles || [],
        permissions: user.permissions || [],
        unread_count: countUnreadFor(current, username),
        ...lastReceived,
        ...getPresenceForUser(username)
      };
    })
    .sort((a, b) => (
      (b.last_received_ms || 0) - (a.last_received_ms || 0)
      || a.username.localeCompare(b.username)
    ))
    .map(({ last_received_ms, ...user }) => user);

  return res.json({
    enabled: true,
    current_user: current,
    users
  });
}

function handleThread(req, res) {
  if (!ensureEnabled(res)) return;
  const current = ensureActor(req, res);
  if (!current) return;

  const other = normaliseUsername(req.params.username);
  if (!getMessageableUser(other) || other === current) {
    return res.status(404).json({ error: "Recipient not found" });
  }

  const thread = getThread(current, other, { markRead: true });
  return res.json({
    enabled: true,
    current_user: current,
    other_user: other,
    messages: thread,
    unread_total: getStatusFor(current).unread_total
  });
}

function handleSend(req, res) {
  if (!ensureEnabled(res)) return;
  const current = ensureActor(req, res);
  if (!current) return;

  try {
    const result = sendMessage(current, req.body?.to, req.body?.body, {
      attention: req.body?.attention === true
    });
    return res.status(201).json({
      message: buildMessageView(result.messages[0], current),
      messages: result.messages.map((message) => buildMessageView(message, current)),
      broadcast: result.broadcast,
      recipient_count: result.recipient_count,
      unread_total: getStatusFor(current).unread_total
    });
  } catch (error) {
    const status = error.status || 500;
    const messagesByCode = {
      sender_not_allowed: "Messaging is not available for this user",
      recipient_not_found: "Recipient not found",
      cannot_message_self: "Choose another user to send a message.",
      no_broadcast_recipients: "No other users are available.",
      empty_message: "Message text is required.",
      message_too_long: `Message must be ${MESSAGING_MAX_MESSAGE_CHARS} characters or fewer.`
    };
    return res.status(status).json({ error: messagesByCode[error.message] || "Failed to send message" });
  }
}

function handleItems(req, res) {
  if (!ensureEnabled(res)) return;
  const current = ensureActor(req, res);
  if (!current) return;

  try {
    const items = searchItems({
      auctionId: req.query.auction_id,
      query: req.query.q
    });
    return res.json({ items });
  } catch (error) {
    return res.status(error.status || 500).json({ error: error.message === "invalid_auction_id" ? "Invalid auction_id" : "Failed to search items" });
  }
}

function handleMaintenanceStats(_req, res) {
  return res.json({
    config: getConfigSummary(),
    stats: getStats()
  });
}

function handleMaintenanceClear(_req, res) {
  return res.json(clearMessages());
}

function handleMaintenanceExport(_req, res) {
  const csv = exportCsv();
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=\"operator_messages.csv\"");
  return res.send(csv);
}

initialisePersistence();
startPersistenceTimer();
process.once("beforeExit", () => flushPersistence({ force: false }));
process.once("SIGINT", () => {
  flushPersistence({ force: false });
  process.exit(130);
});
process.once("SIGTERM", () => {
  flushPersistence({ force: false });
  process.exit(143);
});

module.exports = {
  getConfigSummary,
  getStats,
  clearMessages,
  exportCsv,
  handleStatus,
  handleUsers,
  handleThread,
  handleSend,
  handleItems,
  handleMaintenanceStats,
  handleMaintenanceClear,
  handleMaintenanceExport
};
