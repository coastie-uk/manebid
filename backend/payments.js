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
const { getTransactionByForeignReference: fetchTransactionByForeignReference } = require('./sumup-client');
const api = express.Router();
api.use(express.json());
const SUMUP_RESULT_PATH = '/cashier/sumup-result.html';
const APP_CALLBACK_STATUSES = new Set(['success', 'failed', 'invalidstate']);
const appVerificationInFlight = new Map();

function paymentLogRef(value) {
  return crypto
    .createHash('sha256')
    .update(String(value || ''))
    .digest('hex')
    .slice(0, 12);
}

const posInt = (x) => Number.isInteger(x) && x > 0;

function formatLocalSqlDateTime(date = new Date()) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
}

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


// API to create a payment intent
// supports channels: 'hosted' (desktop/QR), 'app' (direct app)

api.post('/payments/intents', authenticateRole("cashier"), checkAuctionState(['settlement']), async (req, res) => {
  try {
   expireStaleIntents();
    const { bidder_id, amount_minor, donation_minor = 0, currency, channel, note } = req.body || {};
    if (!posInt(bidder_id) || !Number.isInteger(amount_minor) || amount_minor < 0 || !Number.isInteger(donation_minor) || donation_minor < 0) {
      return res.status(400).json({ error: 'invalid parameters' });
    }
    if (amount_minor <= 0 && donation_minor <= 0) return res.status(400).json({ error: 'invalid parameters' });
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
    
    const totals = getBidderPaymentTotals(db, bidder_id, requestAuctionId);
    const outstanding_minor = Math.max(0, Math.round((totals.balance || 0) * 100));
    const gross_minor = amount_minor + donation_minor;
    logFromRequest(req, logLevels.DEBUG, `Bidder ${bidder_id} outstanding amount=${outstanding_minor}, payment requested=${amount_minor}, donation requested=${donation_minor}, gross requested=${gross_minor}`);
    if (amount_minor > outstanding_minor) {
      logFromRequest(req, logLevels.WARN, `Intent amount exceeds outstanding: bidder=${bidder_id} amount_minor=${amount_minor} outstanding_minor=${outstanding_minor}`);
      return res.status(400).json({ error: 'Amount requested exceeds outstanding', outstanding_minor });
    }
    if (outstanding_minor <= 0 && amount_minor > 0) {
      return res.status(400).json({ error: 'No payment is due for this bidder' });
    }
    if (donation_minor > 0 && outstanding_minor > 0 && amount_minor !== outstanding_minor) {
      return res.status(400).json({ error: 'Donation requires the full outstanding balance to be paid' });
    }

    const intentId = uuidv4();

    const createdAt = formatLocalSqlDateTime();
    const expiresAt = formatLocalSqlDateTime(new Date(Date.now() + PAYMENT_TTL_MIN * 60 * 1000));
if (channel !== 'hosted' && channel !== 'app') {
      logFromRequest(req, logLevels.WARN, `Attempt to create SumUp payment with invalid channel: ${channel}`);
      return res.status(400).json({ error: `Invalid channel specified: ${channel}` });
    }

    //check if the requested channel is enabled in config
    if (channel === 'hosted' && !SUMUP_WEB_ENABLED || channel === 'app' && !SUMUP_CARD_PRESENT_ENABLED) {
      logFromRequest(req, logLevels.WARN, `Attempt to create SumUp payment with disabled channel: ${channel}`);
      return res.status(503).json({ error: `Requested payment method SumUp-${channel} is disabled` });
    }

  //  TODO
    db.prepare(`
      INSERT INTO payment_intents (intent_id, bidder_id, amount_minor, donation_minor, created_by, currency, status, channel, created_at, expires_at, note)
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `).run(intentId, bidder_id, gross_minor, donation_minor, auditActor, CURRENCY, channel, createdAt, expiresAt, sanitisedNote);

    const payload = { intent_id: intentId, amount_minor: gross_minor, donation_minor, currency: CURRENCY };

    if (channel === 'app') {
      const title = getPaymentLabelForBidder(bidder_id);
      payload.deep_link = buildDeepLink({
        amount_minor: gross_minor, currency: CURRENCY, title, external_reference: intentId
      });
    } else {
      const description = getPaymentLabelForBidder(bidder_id);
      const hc = await createHostedCheckout({
        amount_minor: gross_minor, currency: CURRENCY, checkout_reference: intentId, description
      });
      if (hc) {
        db.prepare('UPDATE payment_intents SET sumup_checkout_id=? WHERE intent_id=?')
          .run(hc.checkout_id, intentId);
        payload.hosted_link = hc.url;
      }
    }

    logFromRequest(req, logLevels.INFO, `Intent created ref=${paymentLogRef(intentId)} bidder=${bidder_id} gross_minor=${gross_minor} donation_minor=${donation_minor} channel=${channel}`);
    res.status(201).json(payload);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_create_error ${err.message}`);
    res.status(500).json({ error: 'Error creating payment' });
  }
});

function getPublicIntent(intentId) {
  const row = db.prepare(`
    SELECT intent_id, bidder_id, amount_minor, donation_minor, currency, status, channel, expires_at
    FROM payment_intents WHERE intent_id=?
  `).get(intentId);
  if (!row) return null;
  return {
    ...row,
    verification_state: row.channel === 'app'
      && row.status === 'pending'
      && (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE)
      ? 'unavailable'
      : row.status
  };
}

// --- Poll status (UI fallback while waiting) ---
api.get('/payments/intents/:id', authenticateRole("cashier"), (req, res) => {
  try {
    if (!uuidValidate(req.params.id)) return res.status(400).json({ error: 'invalid_intent_id' });
    const row = getPublicIntent(req.params.id);
    if (!row) return res.status(400).json({ error: 'not_found' });
    res.json(row);
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_get_error ${err.message}`);
    
    res.status(500).json({ error: 'internal_error' });
  }
});

api.post('/payments/intents/:id/verify', authenticateRole("cashier"), async (req, res) => {
  try {
    if (!uuidValidate(req.params.id)) return res.status(400).json({ error: 'invalid_intent_id' });
    const current = getPublicIntent(req.params.id);
    if (!current) return res.status(400).json({ error: 'not_found' });
    const verification = await verifyAndFinalizeIntent(req.params.id, { source: 'cashier-poll' });
    return res.json({
      ...getPublicIntent(req.params.id),
      verification_state: verification?.verification_state || current.verification_state
    });
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `intent_verify_error ${err.message}`);
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
  logFromRequest(req, logLevels.DEBUG, `SumUp webhook received checkout_id_present=${Boolean(req.body?.id)}`);

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
    `SumUp app callback received status=${callbackStatus} transaction_code_present=${Boolean(txCode)}`
  );

  let resultStatus = 'unknown';
  try {
    const result = await verifyAndFinalizeIntent(foreignTxId, {
      source: 'app-callback',
      expectedTransactionCode: txCode
    });
    if (result?.status === 'succeeded') resultStatus = 'success';
    if (result?.status === 'failed') resultStatus = 'failed';
  } catch (err) {
    logFromRequest(req, logLevels.ERROR, `SumUp app callback verification unavailable: ${err.message}`);
  }
  return res.redirect(303, `${SUMUP_RESULT_PATH}?status=${resultStatus}`);
}

function readScalar(value, maxLength = 128) {
  return typeof value === 'string' && value.length <= maxLength ? value.trim() : '';
}

function readStatus(query) {
  const status = readScalar(
    query['smp-status'] || query['smpt-status'] || query.status,
    32
  ).toLowerCase();
  return APP_CALLBACK_STATUSES.has(status) ? status : 'unknown';
}

function readForeignTxId(query) {
  return readScalar(query['foreign-tx-id'] || query.foreign_tx_id, 64) || null;
}

function readTxCode(query) {
  const value = readScalar(query['smp-tx-code'] || query.smp_tx_code, 128);
  return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
}


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

async function verifyAndFinalizeIntent(intentId, options = {}) {
  const existing = appVerificationInFlight.get(intentId);
  if (existing) return existing;
  const pending = verifyAndFinalizeIntentOnce(intentId, options)
    .finally(() => appVerificationInFlight.delete(intentId));
  appVerificationInFlight.set(intentId, pending);
  return pending;
}

// --- Verification (server-to-server) then finalize into payments table ---
async function verifyAndFinalizeIntentOnce(
  intentId,
  { source = 'manual', expectedTransactionCode = null } = {}
) {
  const intent = db.prepare('SELECT * FROM payment_intents WHERE intent_id=?').get(intentId);
  if (!intent) return { status: 'not_found', verification_state: 'not_found' };
  if (intent.status !== 'pending') {
    return { status: intent.status, verification_state: intent.status };
  }
  const auditUser = intent.created_by || (source === 'webhook' ? 'sumup-web' : 'sumup-app');

  const expiresAtTs = parseLocalSqlDateTime(intent.expires_at);
  if (expiresAtTs && expiresAtTs < Date.now()) {
    db.prepare(`UPDATE payment_intents SET status='expired' WHERE intent_id=? AND status='pending'`).run(intentId);
    return { status: 'expired', verification_state: 'expired' };
  }

  let latest = null;
  let providerSnapshot = null;
  let providerTxn = null;
  if (intent.channel === 'hosted') {
    const list = await getCheckoutsByReference(intent.intent_id);
    latest = Array.isArray(list) ? list.slice(-1)[0] : null;
    if (!latest) {
      log("Payment", logLevels.WARN, 'No SumUp hosted checkout found for pending intent');
      return { status: 'pending', verification_state: 'not_found' };
    }
    providerSnapshot = createProviderSnapshot(latest, intent.channel);
    if (latest.status === 'PENDING') {
      return { status: 'pending', verification_state: 'pending' };
    }
    if (latest.status === 'FAILED') {
      db.prepare(`UPDATE payment_intents SET status='failed' WHERE intent_id=? AND status='pending'`).run(intentId);
      return { status: 'failed', verification_state: 'failed' };
    }
    if (latest.status !== 'PAID') {
      return { status: 'pending', verification_state: 'unknown' };
    }
    providerTxn = latest?.transactions?.[0]?.id || latest?.transactions?.[0]?.transaction_code || null;
    if (!providerTxn) {
      log("Payment", logLevels.ERROR, 'SumUp hosted checkout was paid without a transaction identifier');
      return { status: 'pending', verification_state: 'mismatch' };
    }
  } else if (intent.channel === 'app') {
    if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) {
      log("Payment", logLevels.WARN, 'SumUp app transaction verification is unavailable: API credentials are not configured');
      return { status: 'pending', verification_state: 'unavailable' };
    }
    try {
      latest = await getTransactionByForeignReference(intent.intent_id);
    } catch (error) {
      log("Payment", logLevels.ERROR, `SumUp app transaction verification unavailable: ${error.message}`);
      return { status: 'pending', verification_state: 'unavailable' };
    }
    if (!latest) {
      return { status: 'pending', verification_state: 'not_found' };
    }
    const evaluation = evaluateAppTransaction(intent, latest, {
      merchantCode: SUMUP_MERCHANT_CODE,
      expectedTransactionCode
    });
    if (evaluation.mismatches.length > 0) {
      log("Payment", logLevels.ERROR, `SumUp app transaction verification mismatch: ${evaluation.mismatches.join(',')}`);
    }
    providerSnapshot = createProviderSnapshot(latest, intent.channel);
    if (evaluation.status === 'failed') {
      db.prepare(`UPDATE payment_intents SET status='failed' WHERE intent_id=? AND status='pending'`).run(intentId);
      return { status: 'failed', verification_state: 'failed' };
    }
    if (evaluation.status !== 'succeeded') {
      return {
        status: evaluation.status,
        verification_state: evaluation.verification_state
      };
    }
    providerTxn = evaluation.providerTransactionId;
  } else {
    return { status: 'pending', verification_state: 'unsupported_channel' };
  }

  const amount = Number(toPounds(intent.amount_minor));
  const donationAmount = Number(toPounds(intent.donation_minor || 0));
  const paymentMethod = intent.channel === 'hosted' ? 'sumup-web' : 'sumup-app';
  const createdBy = auditUser;
  const t = db.transaction(() => {
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

    db.prepare(`UPDATE payment_intents SET status = 'succeeded' WHERE intent_id=?`).run(intent.intent_id);
    log("Payment", logLevels.INFO, `Payment intent finalized: amount_minor=${intent.amount_minor}`);
    const bidderRow = db.get(`SELECT paddle_number FROM bidders WHERE id = ?`, [intent.bidder_id]);

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

// Desktop/QR (requires API key + merchant)
async function createHostedCheckout({ amount_minor, currency, checkout_reference, description }) {
  if (!SUMUP_API_KEY || !SUMUP_MERCHANT_CODE) return null; // silently disable if not configured
  const body = {
    amount: Number(toPounds(amount_minor)),
    currency,
    merchant_code: SUMUP_MERCHANT_CODE,
    checkout_reference,
    description,
    hosted_checkout: { enabled: true },
    return_url: SUMUP_RETURN_URL
  };


  const { statusCode, body: responseBody } = await request('https://api.sumup.com/v0.1/checkouts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  const data = await responseBody.json();
  if (statusCode < 200 || statusCode >= 300 || !data?.hosted_checkout_url || !data?.id) {
    log("Payment", logLevels.ERROR, `SumUp checkout request failed with status ${statusCode}`);
    throw new Error('Invalid SumUp checkout response');
  }
  return { url: data.hosted_checkout_url, checkout_id: data.id };
}

async function getCheckoutsByReference(checkout_reference) {
  if (!SUMUP_API_KEY) return [];
  const url = `https://api.sumup.com/v0.1/checkouts?checkout_reference=${encodeURIComponent(checkout_reference)}`;
  const { body } = await request(url, {
    headers: { Authorization: `Bearer ${SUMUP_API_KEY}` },
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  return body.json(); // array, status in ['PENDING','FAILED','PAID']
}

async function getTransactionByForeignReference(foreignTransactionId) {
  return fetchTransactionByForeignReference({
    request,
    apiKey: SUMUP_API_KEY,
    merchantCode: SUMUP_MERCHANT_CODE,
    foreignTransactionId
  });
}

// --- Expire stale intents ---
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
