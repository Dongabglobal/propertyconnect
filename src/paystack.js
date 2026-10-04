import crypto from 'crypto';
import fetch from 'node-fetch';

const BASE = 'https://api.paystack.co';
const SECRET = process.env.PAYSTACK_SECRET_KEY;

// Starts a payment. Returns a hosted checkout URL to redirect the user to.
export async function initializePaystack({ email, amountNgn, reference, callbackUrl, metadata }) {
  const res = await fetch(`${BASE}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountNgn * 100, // Paystack expects kobo
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });
  const data = await res.json();
  if (!data.status) throw new Error(data.message || 'Paystack initialize failed');
  return data.data; // { authorization_url, access_code, reference }
}

// Server-side check — call this after redirect, in addition to (not instead of) the webhook.
export async function verifyPaystack(reference) {
  const res = await fetch(`${BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
    headers: { Authorization: `Bearer ${SECRET}` },
  });
  const data = await res.json();
  return data.data; // data.status === 'success' means it's paid
}

// Confirms a webhook request really came from Paystack.
export function verifyPaystackSignature(rawBody, signatureHeader) {
  const hash = crypto.createHmac('sha512', SECRET).update(rawBody).digest('hex');
  return hash === signatureHeader;
}
