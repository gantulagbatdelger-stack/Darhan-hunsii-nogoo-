// db.js — SQLite database: connection + schema + seed data
// Uses better-sqlite3 (synchronous, file-based — no separate DB server needed).
// The .db file is created on first run at the path below and persists between restarts.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'hors.db');

// Make sure the /data folder exists
const fs = require('fs');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  unit TEXT NOT NULL,
  price INTEGER NOT NULL,
  emoji TEXT,
  color TEXT,
  active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  note TEXT,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
    -- RECEIVED -> PICKING -> PACKED -> DELIVERING -> DELIVERED
  payment_status TEXT NOT NULL DEFAULT 'UNPAID',
    -- UNPAID -> PAID  (or FAILED)
  qpay_invoice_id TEXT,
  qpay_qr_text TEXT,
  qpay_qr_image TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  unit TEXT NOT NULL,
  price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS order_status_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Seed products once
const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
if (count === 0) {
  const insert = db.prepare(`
    INSERT INTO products (id, name, category, unit, price, emoji, color)
    VALUES (@id, @name, @category, @unit, @price, @emoji, @color)
  `);
  const seed = [
    { id: 1, name: 'Улаан лууван', category: 'үндэслэг', unit: 'кг', price: 3200, emoji: '🥕', color: '#f3c78a' },
    { id: 2, name: 'Цагаан төмс', category: 'үндэслэг', unit: 'кг', price: 2400, emoji: '🥔', color: '#e6d3ad' },
    { id: 3, name: 'Цагаан байцаа', category: 'навчит', unit: 'кг', price: 1900, emoji: '🥬', color: '#c9e0a6' },
    { id: 4, name: 'Улаан лооль', category: 'жимслэг', unit: 'кг', price: 5600, emoji: '🍅', color: '#f0b3a8' },
    { id: 5, name: 'Өргөст хэмх', category: 'жимслэг', unit: 'кг', price: 3800, emoji: '🥒', color: '#b9dcae' },
    { id: 6, name: 'Сонгино', category: 'үндэслэг', unit: 'кг', price: 2600, emoji: '🧅', color: '#e9d6b8' },
    { id: 7, name: 'Сармис', category: 'үндэслэг', unit: 'кг', price: 9800, emoji: '🧄', color: '#efe8d8' },
    { id: 8, name: 'Улаан манжин', category: 'үндэслэг', unit: 'кг', price: 2900, emoji: '🫐', color: '#dcb3cf' },
    { id: 9, name: 'Салат навч', category: 'навчит', unit: 'боодол', price: 4500, emoji: '🥗', color: '#c3e3ac' },
    { id: 10, name: 'Ногоон сонгино', category: 'навчит', unit: 'боодол', price: 2100, emoji: '🌿', color: '#b7dba3' },
    { id: 11, name: 'Чинжүү', category: 'жимслэг', unit: 'кг', price: 6200, emoji: '🫑', color: '#a9d9a4' },
    { id: 12, name: 'Хачир (кабачок)', category: 'жимслэг', unit: 'кг', price: 3400, emoji: '🥒', color: '#cfe3ab' },
  ];
  const insertMany = db.transaction((rows) => rows.forEach((r) => insert.run(r)));
  insertMany(seed);
  console.log(`[db] seeded ${seed.length} products`);
}

module.exports = db;
