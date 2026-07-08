async function getTransactionByForeignReference({
  request,
  apiKey,
  merchantCode,
  foreignTransactionId
}) {
  return getTransactionByQuery({
    request,
    apiKey,
    merchantCode,
    query: { foreign_transaction_id: foreignTransactionId },
    match: (transaction) =>
      String(transaction?.foreign_transaction_id || '') === String(foreignTransactionId)
  });
}

async function getTransactionByCode({
  request,
  apiKey,
  merchantCode,
  transactionCode
}) {
  return getTransactionByQuery({
    request,
    apiKey,
    merchantCode,
    query: { transaction_code: transactionCode },
    match: (transaction) =>
      String(transaction?.transaction_code || '') === String(transactionCode)
  });
}

async function getTransactionHistoryByCode({
  request,
  apiKey,
  merchantCode,
  transactionCode
}) {
  const transaction = await getTransactionHistoryByQuery({
    request,
    apiKey,
    merchantCode,
    query: { transaction_code: transactionCode, limit: '10', order: 'descending' },
    match: (item) =>
      String(item?.transaction_code || '') === String(transactionCode)
  });
  if (!transaction) return null;
  return {
    ...transaction,
    id: transaction.id || transaction.transaction_id || null,
    merchant_code: transaction.merchant_code || merchantCode
  };
}

async function getTransactionByQuery({
  request,
  apiKey,
  merchantCode,
  query,
  match
}) {
  if (typeof request !== 'function') {
    throw new TypeError('A request implementation is required.');
  }
  const cleanQuery = Object.fromEntries(
    Object.entries(query || {}).filter(([, value]) => value)
  );
  if (!apiKey || !merchantCode || Object.keys(cleanQuery).length === 0) return null;

  const merchantPath = encodeURIComponent(merchantCode);
  const params = new URLSearchParams(cleanQuery);
  const url = `https://api.sumup.com/v2.1/merchants/${merchantPath}/transactions?${params.toString()}`;
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    },
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  const data = await body.json().catch(() => null);
  if (statusCode === 404) return null;
  if (statusCode < 200 || statusCode >= 300 || !data) {
    throw new Error(`SumUp Transactions API returned status ${statusCode}`);
  }
  if (Array.isArray(data)) {
    return data.find(match) || null;
  }
  return data;
}

async function getTransactionHistoryByQuery({
  request,
  apiKey,
  merchantCode,
  query,
  match
}) {
  if (typeof request !== 'function') {
    throw new TypeError('A request implementation is required.');
  }
  const cleanQuery = Object.fromEntries(
    Object.entries(query || {}).filter(([, value]) => value)
  );
  if (!apiKey || !merchantCode || Object.keys(cleanQuery).length === 0) return null;

  const merchantPath = encodeURIComponent(merchantCode);
  const params = new URLSearchParams(cleanQuery);
  const url = `https://api.sumup.com/v2.1/merchants/${merchantPath}/transactions/history?${params.toString()}`;
  const { statusCode, body } = await request(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    },
    headersTimeout: 5000,
    bodyTimeout: 10000
  });
  const data = await body.json().catch(() => null);
  if (statusCode === 404) return null;
  if (statusCode < 200 || statusCode >= 300 || !data) {
    throw new Error(`SumUp Transactions history API returned status ${statusCode}`);
  }
  const items = Array.isArray(data?.items) ? data.items : [];
  return items.find(match) || null;
}

module.exports = {
  getTransactionByForeignReference,
  getTransactionByCode,
  getTransactionHistoryByCode
};
