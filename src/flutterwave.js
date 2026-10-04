import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE = 'https://api.flutterwave.com/v3';
const SECRET = process.env.FLW_SECRET_KEY;

// Starts a payment. Returns a hosted checkout URL to redirect the user to.
export async function initializeFlutterwave({ email, amountNgn, reference, redirectUrl, metadata }) {
  const res = await fetch(`${BASE}/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tx_ref: reference,
      amount: amountNgn,
      currency: 'NGN',
      redirect_url: redirectUrl,
      customer: { email },
      meta: metadata,
    }),
  });
  const data = await res.json();
  if (data.status !== 'success') throw new Error(data.message || 'Flutterwave initialize failed');
  return data.data; // { link }
}

// Server-side check — call this after redirect, in addition to (not instead of) the webhook.
export async function verifyFlutterwave(transactionId) {
  const res = await fetch(`${BASE}/transactions/${transactionId}/verify`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const data = await res.json();
  return data.data; // data.status === 'successful' means it's paid
}

// Confirms a webhook request really came from Flutterwave (simple shared-secret hash, not HMAC).
export function verifyFlutterwaveSignature(signatureHeader) {
  return signatureHeader === process.env.FLW_WEBHOOK_HASH;
}
