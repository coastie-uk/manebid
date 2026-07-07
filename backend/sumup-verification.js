const SUMUP_TRANSACTION_STATUSES = new Set([
  'SUCCESSFUL',
  'FAILED',
  'CANCELLED',
  'PENDING',
  'REFUNDED'
]);

function providerAmountMinor(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
}

function appTransactionMismatches(
  intent,
  transaction,
  { merchantCode, expectedTransactionCode = null } = {}
) {
  const mismatches = [];
  if (String(transaction?.foreign_transaction_id || '') !== String(intent?.intent_id || '')) {
    mismatches.push('foreign_transaction_id');
  }
  if (String(transaction?.merchant_code || '') !== String(merchantCode || '')) {
    mismatches.push('merchant_code');
  }
  if (
    String(transaction?.currency || '').toUpperCase()
    !== String(intent?.currency || '').toUpperCase()
  ) {
    mismatches.push('currency');
  }
  if (providerAmountMinor(transaction?.amount) !== Number(intent?.amount_minor)) {
    mismatches.push('amount');
  }
  if (
    expectedTransactionCode
    && String(transaction?.transaction_code || '') !== String(expectedTransactionCode)
  ) {
    mismatches.push('transaction_code');
  }
  return mismatches;
}

function evaluateAppTransaction(intent, transaction, options = {}) {
  if (!transaction) {
    return { status: 'pending', verification_state: 'not_found', mismatches: [] };
  }
  const providerStatus = String(transaction.status || '').toUpperCase();
  if (!SUMUP_TRANSACTION_STATUSES.has(providerStatus)) {
    return { status: 'pending', verification_state: 'unknown', mismatches: [] };
  }
  const mismatches = appTransactionMismatches(intent, transaction, options);
  if (mismatches.length > 0) {
    return { status: 'pending', verification_state: 'mismatch', mismatches };
  }
  if (providerStatus === 'PENDING') {
    return { status: 'pending', verification_state: 'pending', mismatches: [] };
  }
  if (['FAILED', 'CANCELLED', 'REFUNDED'].includes(providerStatus)) {
    return { status: 'failed', verification_state: 'failed', mismatches: [] };
  }
  const providerTransactionId = transaction.id || transaction.transaction_code || null;
  if (!providerTransactionId) {
    return {
      status: 'pending',
      verification_state: 'mismatch',
      mismatches: ['provider_transaction_id']
    };
  }
  return {
    status: 'succeeded',
    verification_state: 'succeeded',
    mismatches: [],
    providerTransactionId
  };
}

module.exports = {
  appTransactionMismatches,
  evaluateAppTransaction,
  providerAmountMinor
};
