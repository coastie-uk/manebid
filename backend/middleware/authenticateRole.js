/**
 * Authentication / authorisation helpers.
 */

const jwt = require('jsonwebtoken');
const { SECRET_KEY } = require('../config');
const { logFromRequest, logLevels } = require('../logger');
const {
  ROLE_LIST,
  ROLE_SET,
  PERMISSION_LIST,
  PERMISSION_SET
} = require('../auth-constants');
const {
  shapeUserAccess,
  getPrimaryRole,
  getUserByUsername,
  isSessionTokenCurrent
} = require('../users');

const VALID_ROLES = new Set(ROLE_LIST);
const VALID_PERMISSIONS = new Set(PERMISSION_LIST);
const SESSION_COOKIE_NAME = 'manebid_session';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function normalizeAcceptedValues(input, validSet, label) {
  const values = Array.isArray(input) ? [...input] : [input];
  values.forEach((value) => {
    if (!validSet.has(value)) {
      throw new TypeError(`Invalid ${label} "${value}" supplied`);
    }
  });
  return new Set(values);
}

function attachDecodedUser(req, decoded) {
  const username = typeof decoded?.username === 'string'
    ? decoded.username
    : (typeof decoded?.role === 'string' ? decoded.role : 'unknown');
  const access = shapeUserAccess(decoded || {});

  req.user = {
    ...decoded,
    username,
    roles: access.roles,
    permissions: access.permissions,
    is_root: access.is_root,
    role: getPrimaryRole(access),
    auditUser: username
  };

  return req.user;
}

function parseCookies(req) {
  const cookies = {};
  const raw = req.headers.cookie;
  if (!raw || typeof raw !== 'string') return cookies;
  raw.split(';').forEach((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      cookies[key] = decodeURIComponent(value);
    } catch (_error) {
      cookies[key] = value;
    }
  });
  return cookies;
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE_NAME] || null;
}

function resolveSession(req) {
  const token = getSessionToken(req);
  if (!token) {
    const error = new Error('Access denied');
    error.status = 403;
    throw error;
  }

  let decoded;
  try {
    decoded = jwt.verify(token, SECRET_KEY, { algorithms: ['HS256'] });
  } catch (_error) {
    const error = new Error('Session expired');
    error.status = 403;
    throw error;
  }

  const currentUser = getUserByUsername(decoded?.username || '');
  if (!currentUser) {
    const error = new Error('Session expired');
    error.status = 403;
    throw error;
  }
  if (!isSessionTokenCurrent(currentUser, decoded)) {
    const error = new Error('Session invalidated');
    error.status = 403;
    error.reason = 'remote_logout';
    throw error;
  }

  const currentAccess = shapeUserAccess(currentUser);
  const scopedAccess = decoded?.session_scope === 'slideshow'
    ? { roles: currentAccess.roles.includes('slideshow') ? ['slideshow'] : [], permissions: [], is_root: 0 }
    : currentAccess;
  const user = attachDecodedUser(req, {
    username: currentUser.username,
    session_invalid_before: currentUser.session_invalid_before,
    session_scope: decoded?.session_scope || 'operator',
    csrf_token: decoded?.csrf_token,
    roles: scopedAccess.roles,
    permissions: scopedAccess.permissions,
    is_root: scopedAccess.is_root
  });
  return { token, decoded, currentUser, user };
}

function hasValidCsrf(req, decoded) {
  const supplied = req.get('X-CSRF-Token');
  const expected = decoded?.csrf_token;
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const suppliedBuffer = Buffer.from(supplied);
  const expectedBuffer = Buffer.from(expected);
  return suppliedBuffer.length === expectedBuffer.length
    && require('crypto').timingSafeEqual(suppliedBuffer, expectedBuffer);
}

function authenticateSession(req, res, next) {
  try {
    const session = resolveSession(req);
    if (!SAFE_METHODS.has(req.method) && !hasValidCsrf(req, session.decoded)) {
      return res.status(403).json({ error: 'Invalid CSRF token' });
    }
    req.session = session;
    return next();
  } catch (error) {
    if (error.reason === 'remote_logout') {
      logFromRequest(req, logLevels.INFO, 'Session invalidated');
    }
    return res.status(error.status || 403).json({ error: error.message, ...(error.reason ? { reason: error.reason } : {}) });
  }
}

function authenticateRole(acceptedRoles) {
  const roleSet = normalizeAcceptedValues(acceptedRoles, VALID_ROLES, 'role');

  return [
    authenticateSession,
    (req, res, next) => {
      if (req.user.roles.some((role) => roleSet.has(role))) {
        return next();
      }

      logFromRequest(
        req,
        logLevels.WARN,
        `Role mismatch. Allowed: ${[...roleSet].join(', ')}, token roles: ${req.user.roles.join(', ')}`
      );
      return res.status(403).json({ error: 'Unauthorized' });
    }
  ];
}

function authenticatePermission(acceptedPermissions) {
  const permissionSet = normalizeAcceptedValues(acceptedPermissions, VALID_PERMISSIONS, 'permission');

  return [
    authenticateSession,
    (req, res, next) => {
      if (req.user.permissions.some((permission) => permissionSet.has(permission))) {
        return next();
      }

      logFromRequest(
        req,
        logLevels.WARN,
        `Permission mismatch. Allowed: ${[...permissionSet].join(', ')}, token permissions: ${req.user.permissions.join(', ')}`
      );
      return res.status(403).json({ error: 'Unauthorized' });
    }
  ];
}

function authenticateAccess({ roles = [], permissions = [] } = {}) {
  const roleSet = new Set(normalizeAcceptedValues(roles, VALID_ROLES, 'role'));
  const permissionSet = new Set(normalizeAcceptedValues(permissions, VALID_PERMISSIONS, 'permission'));

  return [
    authenticateSession,
    (req, res, next) => {
      const hasRole = [...roleSet].length === 0 || req.user.roles.some((role) => roleSet.has(role));
      const hasPermission = [...permissionSet].length === 0 || req.user.permissions.some((permission) => permissionSet.has(permission));

      if ((roleSet.size > 0 && hasRole) || (permissionSet.size > 0 && hasPermission)) {
        return next();
      }

      logFromRequest(
        req,
        logLevels.WARN,
        `Access mismatch. Allowed roles: ${[...roleSet].join(', ') || 'none'}, allowed permissions: ${[...permissionSet].join(', ') || 'none'}`
      );
      return res.status(403).json({ error: 'Unauthorized' });
    }
  ];
}

module.exports = {
  authenticateSession,
  authenticateRole,
  authenticatePermission,
  authenticateAccess,
  attachDecodedUser,
  resolveSession,
  hasValidCsrf,
  getSessionToken,
  SESSION_COOKIE_NAME,
  VALID_ROLES,
  VALID_PERMISSIONS
};
