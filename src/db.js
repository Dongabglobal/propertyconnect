// Uses Node's own built-in SQLite (needs Node 22+, no native C++ compiling —
// that's what kept failing to build on Render with the old "better-sqlite3" package).
import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data.sqlite');

// SQLite is fine to start with. When you grow, swap this file for Postgres —
// server.js only talks to the database through `db.prepare(...)`.
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// better-sqlite3 had db.transaction(fn); node:sqlite doesn't, so this
// does the same job: run fn's queries, and undo them all if any one fails.
export function transaction(fn) {
  db.exec('BEGIN');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (err) { db.exec('ROLLBACK'); throw err; }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('seller','buyer','agent','tenant')),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  phone TEXT,
  subscribed INTEGER NOT NULL DEFAULT 0,
  subscription_expires_at INTEGER,
  created_at INTEGER NOT NULL
);

-- Properties listed by sellers (for sale) and agents (for rent)
CREATE TABLE IF NOT EXISTS listings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  location TEXT NOT NULL,
  price TEXT NOT NULL,
  type TEXT,
  description TEXT,
  images TEXT NOT NULL DEFAULT '[]',   -- JSON list of photo URLs
  created_at INTEGER NOT NULL
);

-- What buyers and tenants are searching for
CREATE TABLE IF NOT EXISTS buyer_requests (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  location TEXT NOT NULL,
  budget TEXT NOT NULL,
  type TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  from_id TEXT NOT NULL REFERENCES users(id),
  to_id TEXT NOT NULL REFERENCES users(id),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  amount_ngn INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_listings_user ON listings(user_id);
CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(from_id, to_id);
`);

export default db;
