/**
 * @file        payments.js
 * @description Payment processing via SumUp. Supports both app deep-link payments and hosted checkouts with webhook and callback handling, and server-side verification.
 * @author      Chris Staples
 * @license     GPL3
 */

const paymentProcessorVer = 'SumUp 1.3.0(2026-07-05)';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4, validate: uuidValidate } = require('uuid');
const db = require('./db');
const { logLevels, logFromRequest, log } = require('./logger');
const { request } = require('undici');
const { authenticateRole } = require('./middleware/authenticateRole');
const { checkAuctionState } = require('./middleware/checkAuctionState');
const { sanitiseText } = require('./middleware/sanitiseText');
const {
  SUMUP_WEB_ENABLED,
  SUMUP_API_KEY,
  SUMUP_MERCHANT_CODE,
  SUMUP_RETURN_URL,
  SUMUP_CARD_PRESENT_ENABLED,
  SUMUP_AFFILIATE_KEY,
  SUMUP_APP_ID,
  SUMUP_CALLBACK_SUCCESS,
  SUMUP_CALLBACK_FAIL,
  PAYMENT_TTL_MIN,
  CURRENCY
} = require('./config');

const toPounds = (minor) => (minor / 100).toFixed(2);
const {audit, recomputeBalanceAndAudit } = require('./middleware/audit');
const { getBidderPaymentTotals } = require('./payment-utils');
const { getAuditActor } = require('./users');
const {
  appTransactionMismatches,
  evaluateAppTransaction
} = require('./sumup-verification');
const {
  getTransactionByForeignReference: fetchTransactionByForeignReference,
  getTransactionByCode: fetchTransactionByCode,
  getTransactionHistoryByCode: fetchTransactionHistoryByCode
} = require('./sumup-client');
const api = express.Router();
api.use(express.json());
const SUMUP_RESULT_PATH = '/cashier/sumup-result.html';
const APP_CALLBACK_STATUSES = new Set(['success', 'failed', 'invalidstate']);
const appVerificationInFlight = new Map();
const pendingIntentPollCounts = new Map();

// Hash external identifiers before logging so payment references can be correlated
// across log lines without exposing full provider or intent IDs.
function paymentLogRef(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

function paymentDebug(message) {
  log("Payment", logLevels.DEBUG, message);
}

function intentDebugRef(intentId) {
  return `ref=${paymentLogRef(intentId)}`;
}

const posInt = (x) => Number.isInteger(x) && x > 0;

// Store timestamps in the same local SQL datetime format used by the existing
// SQLite schema and reporting queries.
function formatLocalSqlDateTime(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

// Accept both local SQL timestamps and ISO strings because old rows and provider
// callbacks may not always use the same timestamp representation.
function parseLocalSqlDateTime(value) {
  if (!value || typeof value !== 'string') return null;
  const rawValue = value.trim();
  const match = rawValue.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, yyyy, mm, dd, hh, min, ss] = match;
    const parsed = new Date(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      Number(hh),
      Number(min),
      ss ? Number(ss) : 0
    );
    const ts = parsed.getTime();
    if (Number.isFinite(ts)) return ts;
  }

  const isoTs = Date.parse(rawValue);
  return Number.isFinite(isoTs) ? isoTs : null;
}


// Create a SumUp payment intent for a cashier during settlement.
// Supports channels: 'hosted' (desktop/QR) and 'app' (direct SumUp app).
api.post('/payments/intents', authenticateRole("cashier"), checkAuctionState(['settlement']), async (req, res) => {
  try {
   expireStaleIntents();
    const { bidder_id, amount_minor, donation_minor = 0, currency, channel, note } = req.body || {};
    logFromRequest(
      req,
      logLevels.DEBUG,
      `Intent create requested bidder=${bidder_id} auction=${req.auction?.id} channel=${channel} amount_minor=${amount_minor} donation_minor=${donation_minor} currency=${currency || CURRENCY}`
    );
    if (!posInt(bidder_id) || !Number.isInteger(amount_minor) || amount_minor < 0 || !Number.isInteger(donation_minor) || donation_minor < 0) {
      logFromRequest(req, logLevels.DEBUG, `Intent create rejected invalid parameters bidder=${bidder_id} channel=${channel}`);
      return res.status(400).json({ error: 'invalid parameters' });
    }
    if (amount_minor <= 0 && donation_minor <= 0) {
      logFromRequest(req, logLevels.DEBUG, `Intent create rejected zero amount bidder=${bidder_id} channel=${channel}`);
      return res.status(400).json({ error: 'invalid parameters' });
    }
    const sanitisedNote = sanitiseText(note, 100);
    const requestAuctionId = Number(req.auction?.id);
    const auditActor = getAuditActor(req);

    // Bidder must belong to the same auction as the request auction_id.
    const bidderInAuction = db.prepare(`
      SELECT id
      FROM bidders
      WHERE id = ? AND auction_id = ?
    `).get(bidder_id, requestAuctionId);
    if (!bidderInAuction) {
      logFromRequest(req, logLevels.WARN, `Intent bidder/auction mismatch: bidder=${bidder_id} auction_id=${requestAuctionId}`);
      return res.status(400).json({ error: 'Bidder not found for this auction' });
    }
    
    // Validate the chargeable payment portion against the bidder's current
    // outstanding balance, while still allowing donations once the balance is covered.
    const totals = getBidderPaymentTotals(db, bidder_id, requestAuctionId);
    const outstanding_minor = Math.max(0, Math.round((totals.balance || 0) * 100));
    const gross_minor = amount_minor + donation_minor;
    logFromRequest(req, logLevels.DEBUG, `Bidder ${bidder_id} outstanding amount=${outstanding_minor}, payment requested=${amount_minor}, donation requested=${donation_minor}, gross requested=${gross_minor}`);
    if (amount_minor > outstanding_minor) {
      logFromRequest(req, logLevels.WARN, `Intent amount exceeds outstanding: bidder=${bidder_id} amount_minor=${amount_minor} outstanding_minor=${outstanding_minor}`);
      return res.status(400).json({ error: 'Amount requested exceeds outstanding', outstanding_minor });
    }
    if (outstanding_minor <= 0 && amount_minor > 0) {
      logFromRequest(req, logLevels.DEBUG, `Intent create rejected no payment due bidder=${bidder_id} amount_minor=${amount_minor}`);
      return res.status(400).json({ error: 'No payment is due for this bidder' });
    }
    if (donation_minor > 0 && outstanding_minor > 0 && amount_minor !== outstanding_minor) {
      logFromRequest(req, logLevels.DEBUG, `Intent create rejected partial payment with donation bidder=${bidder_id} outstanding_minor=${outstanding_minor} amount_minor=${amount_minor} donation_minor=${donation_minor}`);
      return res.status(400).json({ error: 'Donation requires the full outstanding balance to be paid' });
    }

    if (channel !== 'hosted' && channel !== 'app') {
      logFromRequest(req, logLevels.WARN, `Attempt to create SumUp payment with invalid channel: ${channel}`);
      return res.status(400).json({ error: `Invalid channel specified: ${channel}` });
    }

    //check if the requested channel is enabled in config
    if (channel === 'hosted' && !SUMUP_WEB_ENABLED || channel === 'app' && !SUMUP_CARD_PRESENT_ENABLED) {
      logFromRequest(req, logLevels.WARN, `Attempt to create SumUp payment with disabled channel: ${channel}`);
      return res.status(503).json({ error: `Requested payment method SumUp-${channel} is disabled` });
    }

    const existingPendingIntent = findActivePendingIntentForBidder(bidder_id, requestAuctionId);
    if (existingPendingIntent) {
      logFromRequest(req, logLevels.INFO, `Intent create blocked by pending intent ref=${paymentLogRef(existingPendingIntent.intent_id)} bidder=${bidder_id}`);
      logFromRequest(req, logLevels.DEBUG, `Intent create duplicate pending details ref=${paymentLogRef(existingPendingIntent.intent_id)} status=${existingPendingIntent.status} channel=${existingPendingIntent.channel} expires_at=${existingPendingIntent.expires_at}`);
      return res.status(409).json({
        error: 'pending_sumup_intent',
        pending_intent: existingPendingIntent
      });
    }

    const intentId = uuidv4();

    // Intent expiry limits how long a cashier can keep using a generated link or
    // app payment request before the server will reject finalization.
    const createdAt = formatLocalSqlDateTime();
    const expiresAt = formatLocalSqlDateTime(new Date(Date.now() + PAYMENT_TTL_MIN * 60 * 1000));

    let hostedCheckout = null;
    if (channel === 'hosted') {
      // Hosted payments are created server-side so we can store SumUp's checkout
      // ID and later match webhook notifications back to the local intent.
      const description = getPaymentLabelForBidder(bidder_id);
      hostedCheckout = await createHostedCheckout({
        amount_minor: gross_minor, currency: CURRENCY, checkout_reference: intentId, description
      });
      paymentDebug(`Hosted checkout create result ${intentDebugRef(intentId)} checkout_ref=${paymentLogRef(hostedCheckout?.checkout_id)} hosted_url_present=${Boolean(hostedCheckout?.url)}`);
    }

    db.prepare(`
      INSERT INTO payment_intents (
        intent_id, bidder_id, amount_minor, donation_minor, created_by, currency,
        status, channel, sumup_checkout_id, sumup_hosted_url, sumup_transaction_code,
        last_verification_state, created_at, expires_at, note
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, NULL, ?, ?, ?)
    `).run(
      intentId,
      bidder_id,
      gross_minor,
      donation_minor,
      auditActor,
      CURRENCY,
      channel,
      hostedCheckout?.checkout_id || null,
      hostedCheckout?.url || null,
      createdAt,
      expiresAt,
      sanitisedNote
    );

    const payload = { intent_id: intentId, amount_minor: gross_minor, donation_minor, currency: CURRENCY };

    if (channel === 'app') {
      // App payments are initiated client-side via SumUp's custom URL scheme;
      // the foreign transaction ID is our intent ID for later verification.
      const title = getPaymentLabelForBidder(bidder_id);
      payload.deep_link = buildDeepLink({
        amount_minor: gross_minor, currency: CURRENCY, title, external_reference: intentId
      });
      paymentDebug(`App intent deep link prepared ${intentDebugRef(intentId)} bidder=${bidder_id} gross_minor=${gross_minor}`);
    } else if (hostedCheckout?.url) {
      payload.hosted_link = hostedCheckout.url;
    }

    logFromRequest(req, logLevels.INFO, `Intent created ref=${paymentLogRef(intentId)} bidder=${bidder_id} gross_minor=${gross_minor} donation_minor=${donation_minor} channel=${channel}`);
    res.status(201).json(payload);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_create_error ${err.message}`);
    res.status(500).json({ error: 'Error creating payment' });
  }
});

// Return the cashier-safe representation of an intent, including whether app
// verification is currently unavailable because SumUp API credentials are absent.
function enrichPublicIntent(row) {
  if (!row) return null;
  const {
    sumup_hosted_url: hostedUrl,
    sumup_transaction_code: _transactionCode,
    last_verification_state: lastVerificationState,
    ...publicRow
  } = row;
  let verificationState = row.status;
  if (row.status === 'pending' && lastVerificationState) {
    verificationState = lastVerificationState;
  } else if (
    row.channel === 'app'
    && row.status === 'pending'
    && (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE)
  ) {
    verificationState = 'unavailable';
  }
  return {
    ...publicRow,
    bidder_label: formatPublicBidderLabel(row),
    hosted_link: row.channel === 'hosted' && row.status === 'pending'
      ? hostedUrl || null
      : null,
    verification_state: verificationState
  };
}

function formatPublicBidderLabel(row) {
  const paddle = row?.paddle_number == null ? '' : String(row.paddle_number);
  const name = String(row?.bidder_name || '').trim();
  return name ? `${paddle} - ${name}` : paddle;
}

function getIntentSelectSql(whereClause) {
  return `
    SELECT
      pi.intent_id,
      pi.bidder_id,
      pi.amount_minor,
      pi.donation_minor,
      pi.currency,
      pi.status,
      pi.channel,
      pi.created_at,
      pi.expires_at,
      pi.note,
      pi.sumup_hosted_url,
      pi.sumup_transaction_code,
      pi.last_verification_state,
      b.paddle_number,
      b.name AS bidder_name,
      b.auction_id
    FROM payment_intents pi
    JOIN bidders b ON b.id = pi.bidder_id
    ${whereClause}
  `;
}

function getPublicIntent(intentId) {
  const row = db.prepare(getIntentSelectSql('WHERE pi.intent_id=?')).get(intentId);
  return enrichPublicIntent(row);
}

function findActivePendingIntentForBidder(bidderId, auctionId) {
  const row = db.prepare(`
    ${getIntentSelectSql(`
      WHERE pi.bidder_id = ?
        AND b.auction_id = ?
        AND pi.status = 'pending'
        AND (
          pi.expires_at IS NULL
          OR julianday(pi.expires_at) >= julianday('now', 'localtime')
        )
      ORDER BY pi.created_at DESC
      LIMIT 1
    `)}
  `).get(bidderId, auctionId);
  return enrichPublicIntent(row);
}

function listPendingIntentsForAuction(auctionId) {
  return db.prepare(`
    ${getIntentSelectSql(`
      WHERE b.auction_id = ?
        AND pi.status = 'pending'
        AND (
          pi.expires_at IS NULL
          OR julianday(pi.expires_at) >= julianday('now', 'localtime')
        )
      ORDER BY pi.created_at ASC
    `)}
  `).all(auctionId).map(enrichPublicIntent);
}

api.get('/payments/intents/pending/:auctionId', authenticateRole("cashier"), checkAuctionState(['settlement']), (req, res) => {
  try {
    expireStaleIntents();
    const auctionId = Number(req.auction?.id);
    if (!posInt(auctionId)) return res.status(400).json({ error: 'invalid_auction_id' });
    const intents = listPendingIntentsForAuction(auctionId);
    if (pendingIntentPollCounts.get(auctionId) !== intents.length) {
      pendingIntentPollCounts.set(auctionId, intents.length);
      logFromRequest(req, logLevels.DEBUG, `Pending intents listed auction=${auctionId} count=${intents.length}`);
    }
    res.json({ intents });
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_list_error ${err.message}`);
    res.status(500).json({ error: 'internal_error' });
  }
});

// Poll intent status from the cashier UI while waiting for webhook or callback
// processing to finalize the payment.
api.get('/payments/intents/:id', authenticateRole("cashier"), (req, res) => {
  try {
    if (!uuidValidate(req.params.id)) return res.status(400).json({ error: 'invalid_intent_id' });
    const row = getPublicIntent(req.params.id);
    if (!row) return res.status(400).json({ error: 'not_found' });
    logFromRequest(req, logLevels.DEBUG, `Intent status read ${intentDebugRef(req.params.id)} status=${row.status} channel=${row.channel} verification_state=${row.verification_state}`);
    res.json(row);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_get_error ${err.message}`);
    
    res.status(500).json({ error: 'internal_error' });
  }
});

// Force a server-side verification pass for an intent. The cashier UI uses this
// as a fallback when SumUp webhooks or app callbacks are delayed or unavailable.
api.post('/payments/intents/:id/verify', authenticateRole("cashier"), async (req, res) => {
  try {
    if (!uuidValidate(req.params.id)) return res.status(400).json({ error: 'invalid_intent_id' });
    const current = getPublicIntent(req.params.id);
    if (!current) return res.status(400).json({ error: 'not_found' });
    logFromRequest(req, logLevels.DEBUG, `Intent verify requested ${intentDebugRef(req.params.id)} status=${current.status} channel=${current.channel} verification_state=${current.verification_state}`);
    const verification = await verifyAndFinalizeIntent(req.params.id, { source: 'cashier-poll' });
    logFromRequest(req, logLevels.DEBUG, `Intent verify completed ${intentDebugRef(req.params.id)} result_status=${verification?.status} verification_state=${verification?.verification_state}`);
    const publicIntent = getPublicIntent(req.params.id);
    const responseIntent = {
      ...publicIntent,
      verification_state: verification?.verification_state || publicIntent?.verification_state || current.verification_state
    };
    logFromRequest(req, logLevels.DEBUG, `Intent verify response ${intentDebugRef(req.params.id)} status=${responseIntent.status} channel=${responseIntent.channel} verification_state=${responseIntent.verification_state}`);
    return res.json(responseIntent);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_verify_error ${err.message}`);
    return res.status(500).json({ error: 'internal_error' });
  }
});

api.post('/payments/intents/cancel/:auctionId/:intentId', authenticateRole("cashier"), checkAuctionState(['settlement']), (req, res) => {
  try {
    const auctionId = Number(req.auction?.id);
    const intentId = req.params.intentId;
    if (!posInt(auctionId)) return res.status(400).json({ error: 'invalid_auction_id' });
    if (!uuidValidate(intentId)) return res.status(400).json({ error: 'invalid_intent_id' });

    const current = db.prepare(`
      ${getIntentSelectSql('WHERE pi.intent_id = ? AND b.auction_id = ?')}
    `).get(intentId, auctionId);
    if (!current) return res.status(400).json({ error: 'not_found' });

    if (current.status !== 'pending') {
      logFromRequest(req, logLevels.DEBUG, `Intent cancel rejected ${intentDebugRef(intentId)} status=${current.status}`);
      return res.status(409).json({
        error: 'intent_not_pending',
        intent: enrichPublicIntent(current)
      });
    }

    db.prepare(`
      UPDATE payment_intents
      SET status = 'cancelled'
      WHERE intent_id = ? AND status = 'pending'
    `).run(intentId);

    logFromRequest(req, logLevels.INFO, `Payment intent cancelled ref=${paymentLogRef(intentId)} bidder=${current.bidder_id}`);
    logFromRequest(req, logLevels.DEBUG, `Intent cancel completed ${intentDebugRef(intentId)} auction=${auctionId} channel=${current.channel}`);
    return res.json(getPublicIntent(intentId));
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_cancel_error ${err.message}`);
    return res.status(500).json({ error: 'internal_error' });
  }
});

// --- Test webhook endpoint (GET) ---
// For testing webhook reachability from SumUp dashboard
// Not used in production flow.
api.get('/payments/sumup/webhook', (req, res) => {
  logFromRequest(req, logLevels.INFO, 'SumUp web callback reachability test received');
  return res.redirect(303, `${SUMUP_RESULT_PATH}?mode=test&type=web`);
});

// --- Webhook for hosted checkouts ---
// This is a server-to-server notification from SumUp when the checkout status changes.
// MUST be reachable from the public internet over HTTPS using valid TLS certs (not self-signed).
// See: https://developer.sumup.com/docs/hosted-checkout/webhooks/

api.post('/payments/sumup/webhook', async (req, res) => {
  logFromRequest(req, logLevels.DEBUG, `SumUp webhook received checkout_id_present=${Boolean(req.body?.id)} checkout_ref=${req.body?.id ? paymentLogRef(req.body.id) : 'none'}`);

  try {
    // Minimal shape (hosted): { id: "<checkout_id>", ... }
    const checkoutId = req.body?.id;
    res.status(200).end(); // ACK fast to SumUp as per their docs

    if (!checkoutId) {
      logFromRequest(req, logLevels.WARN, 'webhook_missing_checkout_id');
      return;
    }
    // Link back to our intent via stored checkout id
    const row = db.prepare('SELECT intent_id FROM payment_intents WHERE sumup_checkout_id=?').get(checkoutId);
    if (!row?.intent_id) {
      logFromRequest(req, logLevels.WARN, `webhook_unlinked_checkout checkout_ref=${paymentLogRef(checkoutId)}`);
      return;
    }
    logFromRequest(req, logLevels.DEBUG, `SumUp webhook linked checkout_ref=${paymentLogRef(checkoutId)} ${intentDebugRef(row.intent_id)}`);
    await verifyAndFinalizeIntent(row.intent_id, { raw: req.body, source: 'webhook' });
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `webhook_error ${err.message}`);
  }
});

// API for handling both success and fail callbacks from SumUp app deep-link UX
// Testing indicates that SumUp will sometimes call the success endpoint under failure conditions (!!), so we treat them the same and interpret the status param.
// MUST be reachable from the public internet over HTTPS using valid TLS certs (not self-signed).

api.get('/payments/sumup/callback/success', handleSumupAppCallback);
api.get('/payments/sumup/callback/fail', handleSumupAppCallback);

// Handle SumUp app return redirects. The callback itself is not trusted as proof
// of payment; it only triggers server-side lookup and verification.
async function handleSumupAppCallback(req, res) {
  const callbackStatus = readStatus(req.query);
  const foreignTxId = readForeignTxId(req.query);
  const txCode = readTxCode(req.query);
  if (!foreignTxId && !txCode) {
    logFromRequest(req, logLevels.INFO, 'SumUp app callback reachability test received');
    return res.redirect(303, `${SUMUP_RESULT_PATH}?mode=test&type=app`);
  }

  if (!foreignTxId || !uuidValidate(foreignTxId)) {
    logFromRequest(req, logLevels.WARN, 'SumUp app callback rejected: missing or invalid foreign transaction ID');
    return res.redirect(303, `${SUMUP_RESULT_PATH}?status=unknown`);
  }

  logFromRequest(
    req,
    logLevels.INFO,
    `SumUp app callback received status=${callbackStatus} ${intentDebugRef(foreignTxId)} transaction_code_present=${Boolean(txCode)}`
  );

  const callbackIntent = db.prepare(`
    SELECT channel, status
    FROM payment_intents
    WHERE intent_id = ?
  `).get(foreignTxId);
  const appFailureCallback = callbackIntent?.channel === 'app' && isFailedAppCallbackStatus(callbackStatus);
  if (callbackIntent?.channel === 'app' && txCode) {
    storeAppTransactionCode(foreignTxId, txCode);
  }
  logFromRequest(
    req,
    logLevels.DEBUG,
    `SumUp app callback matched ${intentDebugRef(foreignTxId)} local_status=${callbackIntent?.status || 'not_found'} local_channel=${callbackIntent?.channel || 'not_found'} failure_callback=${appFailureCallback}`
  );

  let resultStatus = 'unknown';
  try {
    // Verify by foreign transaction ID and optional transaction code before
    // showing the cashier/customer a success result.
    const result = await verifyAndFinalizeIntent(foreignTxId, {
      source: 'app-callback',
      expectedTransactionCode: txCode
    });
    if (result?.status === 'succeeded') resultStatus = 'success';
    if (result?.status === 'failed') resultStatus = 'failed';
    logFromRequest(req, logLevels.DEBUG, `SumUp app callback verification result ${intentDebugRef(foreignTxId)} provider_status=${result?.status} verification_state=${result?.verification_state} redirect_status=${resultStatus}`);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `SumUp app callback verification unavailable: ${err.message}`);
  }
  if (resultStatus === 'unknown' && appFailureCallback) {
    markAppIntentFailedFromCallback(foreignTxId, callbackStatus);
    resultStatus = callbackStatus;
  }
  logFromRequest(req, logLevels.DEBUG, `SumUp app callback redirect ${intentDebugRef(foreignTxId)} status=${resultStatus}`);
  return res.redirect(303, `${SUMUP_RESULT_PATH}?status=${resultStatus}`);
}

function readScalar(value, maxLength = 128) {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : '';
}

// Normalize SumUp's callback status aliases into the small state set the result
// page understands.
function readStatus(query) {
  for (const key of Object.keys(query || {})) {
    const match = String(key).toLowerCase().match(/^smp-?t?-status-(success|failed|invalidstate)$/);
    if (match && APP_CALLBACK_STATUSES.has(match[1])) return match[1];
  }
  const status = readScalar(
    query['smp-status'] || query['smpt-status'] || query.status,
    32
  ).toLowerCase();
  return APP_CALLBACK_STATUSES.has(status) ? status : 'unknown';
}

function readForeignTxId(query) {
  return readScalar(query['foreign-tx-id'] || query.foreign_tx_id, 64) || null;
}

// Transaction codes are reflected through the callback URL, so keep the accepted
// character set narrow before using one as a verification hint.
function readTxCode(query) {
  const value = readScalar(query['smp-tx-code'] || query.smp_tx_code, 128);
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}

function isFailedAppCallbackStatus(status) {
  return status === 'failed' || status === 'invalidstate';
}

function markAppIntentFailedFromCallback(intentId, callbackStatus) {
  const info = db.prepare(`
    UPDATE payment_intents
    SET status = 'failed'
    WHERE intent_id = ?
      AND channel = 'app'
      AND status = 'pending'
  `).run(intentId);
  if (info.changes > 0) {
    log("Payment", logLevels.INFO, `App payment intent marked failed from callback status=${callbackStatus} ref=${paymentLogRef(intentId)}`);
  } else {
    paymentDebug(`App payment failure callback did not update intent ${intentDebugRef(intentId)} callback_status=${callbackStatus}`);
  }
}

function storeAppTransactionCode(intentId, transactionCode) {
  const info = db.prepare(`
    UPDATE payment_intents
    SET sumup_transaction_code = ?
    WHERE intent_id = ?
      AND channel = 'app'
      AND status = 'pending'
  `).run(transactionCode, intentId);
  if (info.changes > 0) {
    paymentDebug(`Stored app transaction code for delayed verification ${intentDebugRef(intentId)} tx_code_ref=${paymentLogRef(transactionCode)}`);
  }
}


// Persist only the provider fields needed for audit/debugging instead of storing
// the full SumUp payload.
function createProviderSnapshot(transaction, channel) {
  if (!transaction) return null;
  const sourceTransaction = channel === 'hosted'
    ? (Array.isArray(transaction.transactions) ? transaction.transactions[0] : null)
    : transaction;
  return {
    channel,
    status: transaction.status || null,
    id: sourceTransaction?.id || transaction.id || null,
    transaction_code: sourceTransaction?.transaction_code || transaction.transaction_code || null,
    foreign_transaction_id: transaction.foreign_transaction_id || null,
    merchant_code: transaction.merchant_code || null,
    amount: transaction.amount == null ? null : Number(transaction.amount),
    currency: transaction.currency || null
  };
}

// Coalesce concurrent verification requests for the same intent so duplicate UI
// polls, callbacks, and webhooks do not race each other into finalization.
async function verifyAndFinalizeIntent(intentId, options = {}) {
  const existing = appVerificationInFlight.get(intentId);
  if (existing) {
    paymentDebug(`Intent verification joined in-flight request ${intentDebugRef(intentId)} source=${options.source || 'manual'}`);
    return existing;
  }
  paymentDebug(`Intent verification queued ${intentDebugRef(intentId)} source=${options.source || 'manual'} expected_tx_code_present=${Boolean(options.expectedTransactionCode)}`);
  const pending = verifyAndFinalizeIntentOnce(intentId, options)
    .finally(() => {
      appVerificationInFlight.delete(intentId);
      paymentDebug(`Intent verification cleared in-flight ${intentDebugRef(intentId)} source=${options.source || 'manual'}`);
    });
  appVerificationInFlight.set(intentId, pending);
  return pending;
}

// --- Verification (server-to-server) then finalize into payments table ---
// Re-query SumUp, validate the provider response against the local intent, and
// finalize the local payment exactly once.
async function verifyAndFinalizeIntentOnce(
  intentId,
  { source = 'manual', expectedTransactionCode = null } = {}
) {
  const intent = db.prepare('SELECT * FROM payment_intents WHERE intent_id=?').get(intentId);
  if (!intent) {
    paymentDebug(`Intent verification not found ${intentDebugRef(intentId)} source=${source}`);
    return { status: 'not_found', verification_state: 'not_found' };
  }
  paymentDebug(`Intent verification started ${intentDebugRef(intentId)} source=${source} channel=${intent.channel} status=${intent.status} amount_minor=${intent.amount_minor} donation_minor=${intent.donation_minor || 0} stored_tx_code_present=${Boolean(intent.sumup_transaction_code)}`);
  if (intent.status !== 'pending') {
    paymentDebug(`Intent verification skipped non-pending ${intentDebugRef(intentId)} status=${intent.status} source=${source}`);
    return { status: intent.status, verification_state: intent.status };
  }
  const auditUser = intent.created_by || (source === 'webhook' ? 'sumup-web' : 'sumup-app');

  const expiresAtTs = parseLocalSqlDateTime(intent.expires_at);
  if (expiresAtTs && expiresAtTs < Date.now()) {
    db.prepare(`UPDATE payment_intents SET status='expired' WHERE intent_id=? AND status='pending'`).run(intentId);
    paymentDebug(`Intent verification expired local intent ${intentDebugRef(intentId)} expires_at=${intent.expires_at} source=${source}`);
    return { status: 'expired', verification_state: 'expired' };
  }

  let latest = null;
  let providerSnapshot = null;
  let providerTxn = null;
  if (intent.channel === 'hosted') {
    // Hosted checkouts are verified by checkout reference because webhooks give
    // us only the SumUp checkout ID and checkout status can change asynchronously.
    const list = await getCheckoutsByReference(intent.intent_id);
    latest = Array.isArray(list) ? list.slice(-1)[0] : null;
    paymentDebug(`Hosted checkout lookup completed ${intentDebugRef(intentId)} source=${source} result_count=${Array.isArray(list) ? list.length : 'non_array'} latest_status=${latest?.status || 'none'} checkout_ref=${paymentLogRef(latest?.id || '')}`);
    if (!latest) {
      log("Payment", logLevels.WARN, 'No SumUp hosted checkout found for pending intent');
      return { status: 'pending', verification_state: 'not_found' };
    }
    providerSnapshot = createProviderSnapshot(latest, intent.channel);
    if (latest.status === 'PENDING') {
      db.prepare(`UPDATE payment_intents SET last_verification_state='pending' WHERE intent_id=? AND status='pending'`).run(intentId);
      paymentDebug(`Hosted checkout still pending ${intentDebugRef(intentId)} source=${source}`);
      return { status: 'pending', verification_state: 'pending' };
    }
    if (latest.status === 'FAILED') {
      db.prepare(`UPDATE payment_intents SET last_verification_state='failed' WHERE intent_id=? AND status='pending'`).run(intentId);
      paymentDebug(`Hosted checkout attempt failed but intent remains pending ${intentDebugRef(intentId)} source=${source}`);
      return { status: 'pending', verification_state: 'failed' };
    }
    if (latest.status !== 'PAID') {
      db.prepare(`UPDATE payment_intents SET last_verification_state='unknown' WHERE intent_id=? AND status='pending'`).run(intentId);
      paymentDebug(`Hosted checkout returned unknown status ${intentDebugRef(intentId)} source=${source} provider_status=${latest.status}`);
      return { status: 'pending', verification_state: 'unknown' };
    }
    providerTxn = latest?.transactions?.[0]?.id || latest?.transactions?.[0]?.transaction_code || null;
    paymentDebug(`Hosted checkout paid ${intentDebugRef(intentId)} source=${source} provider_txn_ref=${paymentLogRef(providerTxn)}`);
    if (!providerTxn) {
      log("Payment", logLevels.ERROR, 'SumUp hosted checkout was paid without a transaction identifier');
      return { status: 'pending', verification_state: 'mismatch' };
    }
  } else if (intent.channel === 'app') {
    // App payments cannot be trusted from the callback URL alone; fetch the
    // transaction by our foreign reference and validate merchant, amount,
    // currency, status, and optional transaction code.
    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
      log("Payment", logLevels.WARN, 'SumUp app transaction verification is unavailable: API credentials are not configured');
      return { status: 'pending', verification_state: 'unavailable' };
    }
    const transactionCodeForLookup = expectedTransactionCode || intent.sumup_transaction_code || null;
    paymentDebug(`App transaction verification lookup strategy ${intentDebugRef(intentId)} source=${source} expected_tx_code_present=${Boolean(expectedTransactionCode)} stored_tx_code_present=${Boolean(intent.sumup_transaction_code)} lookup_tx_code_present=${Boolean(transactionCodeForLookup)}`);
    try {
      latest = await getTransactionByForeignReference(intent.intent_id);
      if (!latest && transactionCodeForLookup) {
        paymentDebug(`App transaction foreign reference lookup missed; retrying by transaction code ${intentDebugRef(intent.intent_id)} source=${source}`);
        latest = await getTransactionByCode(transactionCodeForLookup, {
          fallbackForIntentId: intent.intent_id
        });
        if (!latest) {
          paymentDebug(`App transaction code retrieve missed; retrying transaction history ${intentDebugRef(intent.intent_id)} source=${source}`);
          latest = await getTransactionHistoryByCode(transactionCodeForLookup, {
            fallbackForIntentId: intent.intent_id
          });
        }
      }
    } catch (error) {
      log("Payment", logLevels.ERROR, `SumUp app transaction verification unavailable: ${error.message}`);
      return { status: 'pending', verification_state: 'unavailable' };
    }
    if (!latest) {
      paymentDebug(`App transaction lookup returned no match ${intentDebugRef(intentId)} source=${source}`);
      return { status: 'pending', verification_state: 'not_found' };
    }
    const evaluation = evaluateAppTransaction(intent, latest, {
      merchantCode: SUMUP_MERCHANT_CODE,
      expectedTransactionCode: transactionCodeForLookup
    });
    paymentDebug(`App transaction evaluated ${intentDebugRef(intentId)} source=${source} provider_status=${latest.status || 'unknown'} evaluation_status=${evaluation.status} verification_state=${evaluation.verification_state} mismatch_count=${evaluation.mismatches.length} provider_txn_ref=${paymentLogRef(evaluation.providerTransactionId || latest.id || latest.transaction_code || '')}`);
    if (evaluation.mismatches.length > 0) {
      log("Payment", logLevels.ERROR, `SumUp app transaction verification mismatch: ${evaluation.mismatches.join(',')}`);
    }
    providerSnapshot = createProviderSnapshot(latest, intent.channel);
    if (evaluation.status === 'failed') {
      db.prepare(`UPDATE payment_intents SET status='failed' WHERE intent_id=? AND status='pending'`).run(intentId);
      paymentDebug(`App transaction marked failed ${intentDebugRef(intentId)} source=${source} verification_state=${evaluation.verification_state}`);
      return { status: 'failed', verification_state: 'failed' };
    }
    if (evaluation.status !== 'succeeded') {
      paymentDebug(`App transaction not finalized ${intentDebugRef(intentId)} source=${source} evaluation_status=${evaluation.status} verification_state=${evaluation.verification_state}`);
      return {
        status: evaluation.status,
        verification_state: evaluation.verification_state
      };
    }
    providerTxn = evaluation.providerTransactionId;
  } else {
    paymentDebug(`Intent verification unsupported channel ${intentDebugRef(intentId)} channel=${intent.channel} source=${source}`);
    return { status: 'pending', verification_state: 'unsupported_channel' };
  }

  const amount = Number(toPounds(intent.amount_minor));
  const donationAmount = Number(toPounds(intent.donation_minor || 0));
  const paymentMethod = intent.channel === 'hosted' ? 'sumup-web' : 'sumup-app';
  const createdBy = auditUser;
  const t = db.transaction(() => {
    // Idempotency guard: a provider may notify us more than once, and the UI can
    // also trigger verification while a webhook is in flight.
    const existing = db.prepare(`
      SELECT id FROM payments
      WHERE provider = 'sumup' AND intent_id = ?
    `).get(intent.intent_id);

    if (existing && existing.id) {
      log("Payment", logLevels.DEBUG, `Duplicate payment intent finalization ignored: ref=${paymentLogRef(intent.intent_id)}`);
      // Already created a payment for this intent; nothing more to do.
      return;
    }

    db.prepare(`
      INSERT INTO payments (bidder_id, amount, donation_amount, method, note, created_by, provider, provider_txn_id, intent_id, raw_payload, currency, created_at)
      VALUES (?, ?, ?, ? , ?, ?, 'sumup', ?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%S', 'now', 'localtime'))
    `).run(
      intent.bidder_id,
      amount,
      donationAmount,
      paymentMethod,
      intent.note,
      createdBy,
      providerTxn,
      intent.intent_id,
      providerSnapshot ? JSON.stringify(providerSnapshot) : null,
      intent.currency || CURRENCY
    );

    db.prepare(`UPDATE payment_intents SET status = 'succeeded', last_verification_state = NULL WHERE intent_id=?`).run(intent.intent_id);
    log("Payment", logLevels.INFO, `Payment intent finalized: ref=${paymentLogRef(intent.intent_id)} amount_minor=${intent.amount_minor} donation_minor=${intent.donation_minor || 0} channel=${intent.channel}`);
    const bidderRow = db.get(`SELECT paddle_number FROM bidders WHERE id = ?`, [intent.bidder_id]);

    // Record the payment in the audit trail using split payment/donation values
    // so settlement reports can distinguish the balance payment from donations.
    audit(auditUser, 'payment', 'bidder', intent.bidder_id, {
      amount,
      payment_amount: amount - donationAmount,
      donation_amount: donationAmount,
      createdBy,
      paddle: bidderRow.paddle_number,
      intent: intent.intent_id
    });

    const balance = recomputeBalanceAndAudit(intent.bidder_id);
    log("Payment", logLevels.DEBUG, `Payment complete. Bidder ${intent.bidder_id} / paddle number ${bidderRow.paddle_number} new balance after payment: ${balance}`);
  });

  t();
  return { status: 'succeeded', verification_state: 'succeeded' };
}


// Helper functions to create SumUp payment links and hosted checkouts.
// Built as per sumup developer docs.

// Build the SumUp app custom-scheme URL used by card-present devices. The intent
// ID is sent as SumUp's foreign transaction ID for later reconciliation.
function buildDeepLink({ amount_minor, currency, title, external_reference }) {
  const q = new URLSearchParams({
    amount: toPounds(amount_minor),
    currency,
    'affiliate-key': SUMUP_AFFILIATE_KEY,
  });
  q.set('app-id', SUMUP_APP_ID); // optional
  if (title) q.set('title', title);
  q.set('callbacksuccess', SUMUP_CALLBACK_SUCCESS);
  q.set('callbackfail', SUMUP_CALLBACK_FAIL);
  if (external_reference) q.set('foreign-tx-id', external_reference);

  log("Payment", logLevels.DEBUG, 'SumUp app deep link generated');
  return `sumupmerchant://pay/1.0?${q.toString()}`;
}

// Create a SumUp hosted checkout for desktop/QR payment flows.
// Requires API key and merchant configuration.
async function createHostedCheckout({ amount_minor, currency, checkout_reference, description }) {
  if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
    paymentDebug(`Hosted checkout create skipped missing credentials ${intentDebugRef(checkout_reference)} api_key_present=${Boolean(SUMUP_API_KEY)} merchant_present=${Boolean(SUMUP_MERCHANT_CODE)}`);
    return null;
  }
  const body = {
    amount: Number(toPounds(amount_minor)),
    currency,
    merchant_code: SUMUP_MERCHANT_CODE,
    checkout_reference,
    description,
    hosted_checkout: { enabled: true },
    return_url: SUMUP_RETURN_URL
  };

  paymentDebug(`Hosted checkout create request ${intentDebugRef(checkout_reference)} amount_minor=${amount_minor} currency=${currency} merchant_present=${Boolean(SUMUP_MERCHANT_CODE)} return_url_present=${Boolean(SUMUP_RETURN_URL)}`);

  const { statusCode, body: responseBody } = await request('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  const data = await responseBody.json();
  paymentDebug(`Hosted checkout create response ${intentDebugRef(checkout_reference)} status_code=${statusCode} checkout_ref=${paymentLogRef(data?.id || '')} hosted_url_present=${Boolean(data?.hosted_checkout_url)}`);
  if (statusCode < 200 || statusCode >= 300 || !data?.hosted_checkout_url || !data?.id) {
    log("Payment", logLevels.ERROR, `SumUp checkout request failed with status ${statusCode}`);
    throw new Error('Invalid SumUp checkout response');
  }
  return { url: data.hosted_checkout_url, checkout_id: data.id };
}

// Retrieve hosted checkout records by our local checkout reference so webhook
// handling and manual verification can confirm the latest provider status.
async function getCheckoutsByReference(checkout_reference) {
  if (!SUMUP_API_KEY) {
    paymentDebug(`Hosted checkout lookup skipped missing API key ${intentDebugRef(checkout_reference)}`);
    return [];
  }
  const url = `https://api.sumup.com/v0.1/checkouts?checkout_reference=${encodeURIComponent(checkout_reference)}`;
  paymentDebug(`Hosted checkout lookup request ${intentDebugRef(checkout_reference)}`);
  const { statusCode, body } = await request(url, {
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}` },
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  const data = await body.json();
  paymentDebug(`Hosted checkout lookup response ${intentDebugRef(checkout_reference)} status_code=${statusCode} result_count=${Array.isArray(data) ? data.length : 'non_array'}`);
  return data; // array, status in ['PENDING','FAILED','PAID']
}

// Retrieve a SumUp app transaction by the local intent ID recorded as SumUp's
// foreign transaction reference.
async function getTransactionByForeignReference(foreignTransactionId) {
  paymentDebug(`App transaction lookup request ${intentDebugRef(foreignTransactionId)} api_key_present=${Boolean(SUMUP_API_KEY)} merchant_present=${Boolean(SUMUP_MERCHANT_CODE)}`);
  const transaction = await fetchTransactionByForeignReference({
    request,
    apiKey: SUMUP_API_KEY,
    merchantCode: SUMUP_MERCHANT_CODE,
    foreignTransactionId
  });
  paymentDebug(`App transaction lookup response ${intentDebugRef(foreignTransactionId)} found=${Boolean(transaction)} provider_status=${transaction?.status || 'none'} provider_txn_ref=${paymentLogRef(transaction?.id || transaction?.transaction_code || '')}`);
  return transaction;
}

async function getTransactionByCode(transactionCode, options = {}) {
  const refForLog = options.fallbackForIntentId || transactionCode;
  paymentDebug(`App transaction code lookup request ${intentDebugRef(refForLog)} tx_code_ref=${paymentLogRef(transactionCode)} api_key_present=${Boolean(SUMUP_API_KEY)} merchant_present=${Boolean(SUMUP_MERCHANT_CODE)}`);
  const transaction = await fetchTransactionByCode({
    request,
    apiKey: SUMUP_API_KEY,
    merchantCode: SUMUP_MERCHANT_CODE,
    transactionCode
  });
  paymentDebug(`App transaction code lookup response ${intentDebugRef(refForLog)} found=${Boolean(transaction)} provider_status=${transaction?.status || 'none'} provider_txn_ref=${paymentLogRef(transaction?.id || transaction?.transaction_code || '')} foreign_ref=${paymentLogRef(transaction?.foreign_transaction_id || '')}`);
  return transaction;
}

async function getTransactionHistoryByCode(transactionCode, options = {}) {
  const refForLog = options.fallbackForIntentId || transactionCode;
  paymentDebug(`App transaction history lookup request ${intentDebugRef(refForLog)} tx_code_ref=${paymentLogRef(transactionCode)} api_key_present=${Boolean(SUMUP_API_KEY)} merchant_present=${Boolean(SUMUP_MERCHANT_CODE)}`);
  const transaction = await fetchTransactionHistoryByCode({
    request,
    apiKey: SUMUP_API_KEY,
    merchantCode: SUMUP_MERCHANT_CODE,
    transactionCode
  });
  paymentDebug(`App transaction history lookup response ${intentDebugRef(refForLog)} found=${Boolean(transaction)} provider_status=${transaction?.status || 'none'} provider_txn_ref=${paymentLogRef(transaction?.id || transaction?.transaction_code || '')} foreign_ref=${paymentLogRef(transaction?.foreign_transaction_id || '')}`);
  return transaction;
}

// --- Expire stale intents ---
// Mark pending intents as expired once their local TTL has passed. This prevents
// old payment links or app requests from being finalized later.
function expireStaleIntents() {
  const stmt = db.prepare(`
    UPDATE payment_intents
    SET status = 'expired'
    WHERE status = 'pending'
      AND expires_at IS NOT NULL
      AND julianday(expires_at) < julianday('now', 'localtime')
  `);
  const info = stmt.run();
  if (info.changes > 0) {
    log('Payments', logLevels.INFO, `Set ${info.changes} stale payment intents to expired`);
    paymentDebug(`Expired stale payment intents count=${info.changes}`);
  }
}

// Generate a payment description for the SumUp checkout. Includes looking up the paddle number
const getPaymentLabelForBidder = (bidderId) => {
  const row = db.prepare(`
  SELECT a.id AS auction_id, a.short_name, a.full_name, b.paddle_number
  FROM bidders b
  JOIN auctions a ON a.id = b.auction_id
  WHERE b.id = ?
`).get(bidderId);
  if (!row) return `Bidder ${bidderId}`;
  const auctionName = row.full_name || row.short_name;
  return `${auctionName} - Bidder ${row.paddle_number}`;
};

module.exports = {
  api,
  paymentProcessorVer,
  verifyAndFinalizeIntent,
  readStatus,
  appTransactionMismatches
};
