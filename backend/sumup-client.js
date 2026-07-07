async function getTransactionByForeignReference({
  request,
  apiKey,
  merchantCode,
  foreignTransactionId
}) {
  if (typeof request !== 'function') {
    throw new TypeError('A request implementation is required.');
  }
  if (!apiKey || !merchantCode || !foreignTransactionId) return null;

  const merchantPath = encodeURIComponent(merchantCode);
  const query = new URLSearchParams({ foreign_transaction_id: foreignTransactionId });
  const url = `https://api.sumup.com/v2.1/merchants/${merchantPath}/transactions?${query.toString()}`;
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
    return data.find((transaction) =>
      String(transaction?.foreign_transaction_id || '') === String(foreignTransactionId)
    ) || null;
  }
  return data;
}

module.exports = { getTransactionByForeignReference };
