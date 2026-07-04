"use strict";

const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

function redactSensitive(value) {
  return String(value ?? "")
    .replace(JWT_PATTERN, "[REDACTED_JWT]")
    .replace(/\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
}

module.exports = { redactSensitive };
