import 'dotenv/config';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import db, { transaction } from './db.js';
import { hashPassword, checkPassword, signToken, requireAuth } from './auth.js';
import { initializePaystack, verifyPaystack, verifyPaystackSignature } from './paystack.js';
import { initializeFlutterwave, verifyFlutterwave, verifyFlutterwaveSignature } from './flutterwave.js';

if (!process.env.JWT_SECRET) {
  console.error('Missing JWT_SECRET. Copy .env.example to .env and set it.');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const PORT = process.env.PORT || 4000;
const SITE_URL = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const PROVIDER = process.env.PAYMENT_PROVIDER || 'paystack';
const LISTER_PRICE = Number(process.env.LISTER_PRICE_NGN || 5000);
const SEEKER_PRICE = Number(process.env.SEEKER_PRICE_NGN || 3000);
const DAY = 24 * 60 * 60 * 1000;
const MAX_PHOTOS_PER_LISTING = 10;

/*
  WHO CAN TALK TO WHO
    seller ↔ buyer     (buying and selling)
    agent  ↔ tenant    (renting)
  "lister" roles post properties. "seeker" roles post what they're looking for.
*/
const ROLES = {
  seller: { side: 'lister', partner: 'buyer' },
  agent:  { side: 'lister', partner: 'tenant' },
  buyer:  { side: 'seeker', partner: 'seller' },
  tenant: { side: 'seeker', partner: 'agent' },
};

const app = express();
app.set('trust proxy', 1);

/* ---------------- helpers ---------------- */

const uid = (prefix) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const parseImages = (s) => { try { return JSON.parse(s) || []; } catch { return []; } };

// A subscription counts only while it hasn't expired.
const isActive = (u) => !!u.subscribed && (u.subscription_expires_at || 0) > Date.now();
const priceFor = (role) => (ROLES[role].side === 'lister' ? LISTER_PRICE : SEEKER_PRICE);
const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

// The one rule that matters: right partner type AND both subscriptions active.
function canChat(a, b) {
  return ROLES[a.role].partner === b.role && isActive(a) && isActive(b);
}

function publicUser(u) {
  return {
    id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone,
    subscribed: isActive(u), subscriptionEndsAt: u.subscription_expires_at || null,
    createdAt: u.created_at,
  };
}

function shapeListing(r) {
  return {
    id: r.id, title: r.title, location: r.location, price: r.price, type: r.type,
    description: r.description, images: parseImages(r.images), created_at: r.created_at,
    owner_id: r.owner_id, owner_name: r.owner_name, owner_role: r.owner_role,
    owner_subscribed: isActive(r),
  };
}

const requireSide = (side) => (req, res, next) =>
  ROLES[req.userRole]?.side === side
    ? next()
    : res.status(403).json({ error: 'This is not available for your account type' });

function activatePayment(reference, paidNgn) {
  const p = db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference);
  if (!p || p.status === 'success') return p?.status === 'success';
  if (paidNgn != null && paidNgn < p.amount_ngn) return false; // paid less than the price
  const u = getUser(p.user_id);
  const start = Math.max(Date.now(), u?.subscription_expires_at || 0); // renewals stack
  db.prepare('UPDATE payments SET status = ? WHERE reference = ?').run('success', reference);
  db.prepare('UPDATE users SET subscribed = 1, subscription_expires_at = ? WHERE id = ?')
    .run(start + 30 * DAY, p.user_id);
  return true;
}

/* ---------------- webhooks (must come before express.json) ---------------- */

// Paystack signs the RAW body, so this route gets a raw parser.
app.post('/api/webhooks/paystack', express.raw({ type: '*/*' }), (req, res) => {
  if (!verifyPaystackSignature(req.body, req.headers['x-paystack-signature'])) {
    return res.status(401).send('Invalid signature');
  }
  const event = JSON.parse(req.body.toString('utf8'));
  if (event.event === 'charge.success' && event.data?.status === 'success') {
    activatePayment(event.data.reference, Math.floor(event.data.amount / 100));
  }
  res.sendStatus(200);
});

app.use(express.json());

app.post('/api/webhooks/flutterwave', (req, res) => {
  if (!verifyFlutterwaveSignature(req.headers['verif-hash'])) return res.status(401).send('Invalid signature');
  const d = req.body?.data;
  if (d?.status === 'successful' && d?.currency === 'NGN') activatePayment(d.tx_ref, Math.floor(d.amount));
  res.sendStatus(200);
});

/* ---------------- public info ---------------- */

app.get('/api/config', (req, res) => {
  res.json({ listerPrice: LISTER_PRICE, seekerPrice: SEEKER_PRICE });
});

// Homepage preview — no login, no contact details.
app.get('/api/listings/preview', (req, res) => {
  const rows = db.prepare(`
    SELECT l.title, l.location, l.price, l.type, l.images, u.role AS owner_role
    FROM listings l JOIN users u ON u.id = l.user_id
    ORDER BY l.created_at DESC LIMIT 6
  `).all();
  res.json({
    listings: rows.map((r) => ({ ...r, images: parseImages(r.images).slice(0, 1) })),
  });
});

/* ---------------- auth ---------------- */

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false });

app.post('/api/auth/signup', authLimiter, (req, res) => {
  const { role, password, listing, request: seek } = req.body || {};
  const name = clip(req.body?.name, 80);
  const phone = clip(req.body?.phone, 30);
  const email = clip(req.body?.email, 120).toLowerCase();

  if (!ROLES[role]) return res.status(400).json({ error: 'Please choose an account type' });
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email address does not look right' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });

  const isLister = ROLES[role].side === 'lister';
  if (isLister && !(listing?.title && listing?.location && listing?.price)) {
    return res.status(400).json({ error: 'Property title, location and price are required' });
  }
  if (!isLister && !(seek?.location && seek?.budget)) {
    return res.status(400).json({ error: 'Preferred location and budget are required' });
  }
  if (db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
    return res.status(409).json({ error: 'An account with that email already exists — try logging in' });
  }

  const id = uid('u');
  const listingId = isLister ? uid('l') : null;
  transaction(() => {
    db.prepare(`INSERT INTO users (id, role, name, email, password_hash, phone, subscribed, created_at)
                VALUES (?,?,?,?,?,?,0,?)`).run(id, role, name, email, hashPassword(String(password)), phone || null, Date.now());
    if (isLister) {
      db.prepare(`INSERT INTO listings (id, user_id, title, location, price, type, description, images, created_at)
                  VALUES (?,?,?,?,?,?,?,'[]',?)`)
        .run(listingId, id, clip(listing.title, 120), clip(listing.location, 120), clip(listing.price, 60),
             clip(listing.type, 40), clip(listing.description, 2000), Date.now());
    } else {
      db.prepare(`INSERT INTO buyer_requests (id, user_id, location, budget, type, notes, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(uid('b'), id, clip(seek.location, 120), clip(seek.budget, 60), clip(seek.type, 40), clip(seek.notes, 2000), Date.now());
    }
  });

  const user = getUser(id);
  res.json({ token: signToken(user), user: publicUser(user), listingId });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const email = clip(req.body?.email, 120).toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !checkPassword(String(req.body?.password || ''), user.password_hash)) {
    return res.status(401).json({ error: 'Email or password is incorrect' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = getUser(req.userId);
  if (!user) return res.status(401).json({ error: 'Account not found' });
  res.json({ user: publicUser(user) });
});

/* ---------------- browsing ---------------- */

// Seekers (buyers/tenants) see listings from their partner type.
app.get('/api/listings', requireAuth, requireSide('seeker'), (req, res) => {
  const rows = db.prepare(`
    SELECT l.*, u.id AS owner_id, u.name AS owner_name, u.role AS owner_role,
           u.subscribed, u.subscription_expires_at
    FROM listings l JOIN users u ON u.id = l.user_id
    WHERE u.role = ? ORDER BY l.created_at DESC
  `).all(ROLES[req.userRole].partner);
  res.json({ listings: rows.map(shapeListing) });
});

// Listers (sellers/agents) see search requests from their partner type.
app.get('/api/requests', requireAuth, requireSide('lister'), (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, u.id AS owner_id, u.name AS owner_name, u.role AS owner_role,
           u.subscribed, u.subscription_expires_at
    FROM buyer_requests r JOIN users u ON u.id = r.user_id
    WHERE u.role = ? ORDER BY r.created_at DESC
  `).all(ROLES[req.userRole].partner);
  res.json({
    requests: rows.map((r) => ({
      id: r.id, location: r.location, budget: r.budget, type: r.type, notes: r.notes,
      owner_id: r.owner_id, owner_name: r.owner_name, owner_role: r.owner_role, owner_subscribed: isActive(r),
    })),
  });
});

app.get('/api/my-listings', requireAuth, requireSide('lister'), (req, res) => {
  const rows = db.prepare('SELECT * FROM listings WHERE user_id = ? ORDER BY created_at DESC').all(req.userId);
  res.json({ listings: rows.map((r) => ({ ...r, images: parseImages(r.images) })) });
});

app.get('/api/my-request', requireAuth, requireSide('seeker'), (req, res) => {
  const row = db.prepare('SELECT * FROM buyer_requests WHERE user_id = ? ORDER BY created_at DESC').get(req.userId);
  res.json({ request: row || null });
});

/* ---------------- adding properties + photos ---------------- */

app.post('/api/listings', requireAuth, requireSide('lister'), (req, res) => {
  const { title, location, price, type, description } = req.body || {};
  if (!title || !location || !price) return res.status(400).json({ error: 'Title, location and price are required' });
  const id = uid('l');
  db.prepare(`INSERT INTO listings (id, user_id, title, location, price, type, description, images, created_at)
              VALUES (?,?,?,?,?,?,?,'[]',?)`)
    .run(id, req.userId, clip(title, 120), clip(location, 120), clip(price, 60), clip(type, 40), clip(description, 2000), Date.now());
  res.json({ id });
});

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(14).toString('hex') + EXT[file.mimetype]),
  }),
  limits: { fileSize: 6 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) =>
    EXT[file.mimetype] ? cb(null, true) : cb(new Error('Only JPG, PNG or WebP photos are allowed')),
});

const ownListing = (id, userId) => db.prepare('SELECT * FROM listings WHERE id = ? AND user_id = ?').get(id, userId);
const removeFiles = (files) => (files || []).forEach((f) => fs.unlink(f.path, () => {}));

app.post('/api/listings/:id/images', requireAuth, requireSide('lister'), (req, res) => {
  // Check ownership BEFORE accepting any files.
  if (!ownListing(req.params.id, req.userId)) return res.status(404).json({ error: 'Property not found' });

  upload.array('photos', 8)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? 'A photo is too large (max 6 MB each)' : err.message;
      return res.status(400).json({ error: msg });
    }
    const listing = ownListing(req.params.id, req.userId);
    const existing = parseImages(listing.images);
    const room = MAX_PHOTOS_PER_LISTING - existing.length;
    if (!req.files?.length) return res.status(400).json({ error: 'No photos received' });
    if (req.files.length > room) {
      removeFiles(req.files);
      return res.status(400).json({ error: `You can add ${Math.max(room, 0)} more photo(s) to this property (max ${MAX_PHOTOS_PER_LISTING})` });
    }
    const all = [...existing, ...req.files.map((f) => '/uploads/' + f.filename)];
    db.prepare('UPDATE listings SET images = ? WHERE id = ?').run(JSON.stringify(all), listing.id);
    res.json({ images: all });
  });
});

app.delete('/api/listings/:id/images', requireAuth, requireSide('lister'), (req, res) => {
  const listing = ownListing(req.params.id, req.userId);
  if (!listing) return res.status(404).json({ error: 'Property not found' });
  const file = path.basename(String(req.query.url || ''));
  const url = '/uploads/' + file;
  const images = parseImages(listing.images);
  if (!images.includes(url)) return res.status(404).json({ error: 'Photo not found' });
  db.prepare('UPDATE listings SET images = ? WHERE id = ?').run(JSON.stringify(images.filter((i) => i !== url)), listing.id);
  fs.unlink(path.join(UPLOAD_DIR, file), () => {});
  res.json({ ok: true });
});

/* ---------------- subscriptions ---------------- */

app.post('/api/subscribe/initialize', requireAuth, async (req, res) => {
  const user = getUser(req.userId);
  const amount = priceFor(user.role);
  const reference = uid('pay');
  db.prepare(`INSERT INTO payments (id, user_id, provider, reference, amount_ngn, status, created_at)
              VALUES (?,?,?,?,?, 'pending', ?)`).run(uid('rec'), user.id, PROVIDER, reference, amount, Date.now());
  try {
    const callback = `${SITE_URL}/subscribe/callback`;
    if (PROVIDER === 'paystack') {
      const d = await initializePaystack({ email: user.email, amountNgn: amount, reference, callbackUrl: callback, metadata: { userId: user.id } });
      return res.json({ checkoutUrl: d.authorization_url, reference });
    }
    const d = await initializeFlutterwave({ email: user.email, amountNgn: amount, reference, redirectUrl: callback, metadata: { userId: user.id } });
    res.json({ checkoutUrl: d.link, reference });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not start payment — try again shortly' });
  }
});

// Called when the customer comes back from the payment page. The webhook is the
// main confirmation; this is a backup so the page updates immediately.
app.get('/api/subscribe/verify/:reference', requireAuth, async (req, res) => {
  const { reference } = req.params;
  const p = db.prepare('SELECT * FROM payments WHERE reference = ? AND user_id = ?').get(reference, req.userId);
  if (!p) return res.status(404).json({ error: 'Payment not found' });
  try {
    if (p.status !== 'success') {
      if (p.provider === 'paystack') {
        const r = await verifyPaystack(reference);
        if (r?.status === 'success' && r.reference === reference) activatePayment(reference, Math.floor(r.amount / 100));
      } else {
        const r = await verifyFlutterwave(req.query.transaction_id);
        if (r?.status === 'successful' && r.tx_ref === reference && r.currency === 'NGN') activatePayment(reference, Math.floor(r.amount));
      }
    }
    const done = db.prepare('SELECT status FROM payments WHERE reference = ?').get(reference).status === 'success';
    res.json({ success: done });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: 'Could not verify payment' });
  }
});

/* ---------------- messaging (the gated part) ---------------- */

app.get('/api/messages/:otherId', requireAuth, (req, res) => {
  const me = getUser(req.userId);
  const other = getUser(req.params.otherId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  if (!canChat(me, other)) return res.status(403).json({ error: 'Both accounts must be subscribed to view this chat' });
  const rows = db.prepare(`
    SELECT id, from_id, to_id, text, created_at FROM messages
    WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)
    ORDER BY created_at ASC LIMIT 300
  `).all(me.id, other.id, other.id, me.id);
  res.json({ messages: rows });
});

app.post('/api/messages', requireAuth, (req, res) => {
  const text = clip(req.body?.text, 1000);
  if (!req.body?.toId || !text) return res.status(400).json({ error: 'Message text is required' });
  const me = getUser(req.userId);
  const other = getUser(req.body.toId);
  if (!other) return res.status(404).json({ error: 'User not found' });
  // Enforced here on the server — hiding the button in the page is not enough.
  if (!canChat(me, other)) return res.status(403).json({ error: 'Both accounts must be subscribed to message each other' });
  db.prepare('INSERT INTO messages (id, from_id, to_id, text, created_at) VALUES (?,?,?,?,?)')
    .run(uid('m'), me.id, other.id, text, Date.now());
  res.json({ ok: true });
});

/* ---------------- serve photos + the website ---------------- */

app.use('/uploads', express.static(UPLOAD_DIR, {
  maxAge: '7d',
  setHeaders: (res) => res.setHeader('X-Content-Type-Options', 'nosniff'),
}));
app.use(express.static(PUBLIC_DIR));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => console.log(`PropertyConnect running at ${SITE_URL}`));
