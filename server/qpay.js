// qpay.js — QPay Merchant V2 API integration
//
// Real docs: https://developer.qpay.mn (Merchant V2)
// You MUST get your own credentials by registering as a QPay merchant
// (https://qpay.mn -> Бизнесийн бүртгэл) before this will work with real money.
// Sandbox base URL:    https://merchant-sandbox.qpay.mn/v2
// Production base URL: https://merchant.qpay.mn/v2
//
// Required env vars (see .env.example):
//   QPAY_BASE_URL
//   QPAY_USERNAME          (QPay "invoice code" login, given by QPay)
//   QPAY_PASSWORD
//   QPAY_INVOICE_CODE      (given by QPay when your merchant account is approved)
//   QPAY_CALLBACK_URL      (public URL QPay will POST to when a payment succeeds,
//                            e.g. https://yourdomain.mn/api/qpay/callback)

// Uses the built-in global fetch (Node 18+). No extra HTTP library needed.

const BASE_URL = process.env.QPAY_BASE_URL || 'https://merchant-sandbox.qpay.mn/v2';
const USERNAME = process.env.QPAY_USERNAME || '';
const PASSWORD = process.env.QPAY_PASSWORD || '';
const INVOICE_CODE = process.env.QPAY_INVOICE_CODE || '';
const CALLBACK_URL = process.env.QPAY_CALLBACK_URL || '';

let tokenCache = { access_token: null, refresh_token: null, expiresAt: 0 };

const credentialsConfigured = () => Boolean(USERNAME && PASSWORD && INVOICE_CODE);

/** Get a valid access token, requesting or refreshing one as needed. */
async function getToken() {
  if (!credentialsConfigured()) {
    throw new Error('QPAY_NOT_CONFIGURED');
  }
  const now = Date.now();
  if (tokenCache.access_token && now < tokenCache.expiresAt - 5000) {
    return tokenCache.access_token;
  }

  const basic = Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64');
  const res = await fetch(`${BASE_URL}/auth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    throw new Error(`QPay auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  tokenCache = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    // expires_in is in seconds
    expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return tokenCache.access_token;
}

/**
 * Create an invoice for an order. Returns { invoice_id, qr_text, qr_image, urls }.
 * amount is in whole MNT (tögrög).
 */
async function createInvoice({ orderNumber, amount, description, customerPhone }) {
  const token = await getToken();
  const body = {
    invoice_code: INVOICE_CODE,
    sender_invoice_no: orderNumber,
    invoice_receiver_code: customerPhone || 'terminal',
    invoice_description: description || `Захиалга ${orderNumber}`,
    amount,
    callback_url: `${CALLBACK_URL}?order=${encodeURIComponent(orderNumber)}`,
  };

  const res = await fetch(`${BASE_URL}/invoice`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`QPay createInvoice failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return {
    invoice_id: data.invoice_id,
    qr_text: data.qr_text,
    qr_image: data.qr_image, // base64 PNG
    deeplinks: data.urls || [], // bank app deep links
  };
}

/** Check whether an invoice has been paid. Returns true/false. */
async function checkPayment(invoiceId) {
  const token = await getToken();
  const res = await fetch(`${BASE_URL}/payment/check`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      object_type: 'INVOICE',
      object_id: invoiceId,
      offset: { page_number: 1, page_limit: 100 },
    }),
  });
  if (!res.ok) {
    throw new Error(`QPay checkPayment failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return (data.count || 0) > 0 && data.rows?.some((r) => r.payment_status === 'PAID');
}

module.exports = { createInvoice, checkPayment, credentialsConfigured };
