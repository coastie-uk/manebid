"use strict";

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const SENSITIVE_KEY_PATTERN = /(^|[?&\s,;])((?:affiliate[-_]?key)|(?:app[-_]?id)|(?:foreign[-_]?tx[-_]?id)|(?:smp[-_]?tx[-_]?code)|(?:checkout[-_]?reference)|(?:checkout[-_]?id)|(?:intent[-_]?id)|(?:callbacksuccess)|(?:callbackfail))=([^&\s,;]+)/gi;

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function redactExactSecret(text, secret, label) {
  const value = String(secret || "");
  if (value.length < 4) return text;
  return text.replace(new RegExp(escapeRegExp(value), "g"), `[REDACTED_${label}]`);
}

function redactSensitive(value) {
  let text = String(value ?? "")
    .replace(/[\r\n]/g, " ")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "?")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(SENSITIVE_KEY_PATTERN, "$1$2=[REDACTED]")
    .replace(UUID_PATTERN, "[REDACTED_UUID]");

  text = redactExactSecret(text, process.env.SUMUP_API_KEY, "SUMUP_API_KEY");
  text = redactExactSecret(text, process.env.SUMUP_AFFILIATE_KEY, "SUMUP_AFFILIATE_KEY");
  text = redactExactSecret(text, process.env.SUMUP_APP_ID, "SUMUP_APP_ID");
  return text;
}

module.exports = { redactSensitive };
