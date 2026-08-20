require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');
const qpay = require('./qpay');
const telegram = require('./telegram');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = process.env.PORT || 3000;

// Order lifecycle. Orders move through these in sequence.
const STATUS_FLOW = ['RECEIVED', 'PICKING', 'PACKED', 'DELIVERING', 'DELIVERED'];

function generateOrderNumber() {
  const n = Math.floor(1000 + Math.random() * 9000);
  return `ХӨРС-${n}`;
}

function logStatus(orderId, status) {
  db.prepare('INSERT INTO order_status_log (order_id, status) VALUES (?, ?)').run(orderId, status);
  db.prepare("UPDATE orders SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, orderId);
}

// ---------- COURIER / ADMIN AUTH ----------
// Simple shared-PIN protection so random visitors can't advance or list orders.
// Set COURIER_PIN in .env. Courier page sends it back as the x-courier-pin header.
const COURIER_PIN = process.env.COURIER_PIN || '';
function requireCourierPin(req, res, next) {
  if (!COURIER_PIN) {
    return res.status(503).json({ error: 'COURIER_PIN тохируулагдаагүй байна (.env үзнэ үү)' });
  }
  const pin = req.header('x-courier-pin') || req.query.pin;
  if (pin !== COURIER_PIN) {
    return res.status(401).json({ error: 'PIN буруу байна' });
  }
  next();
}

// ---------- PRODUCTS (нийтэд харагдах, зөвхөн идэвхтэй) ----------
app.get('/api/products', (req, res) => {
  const products = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY id').all();
  res.json(products);
});

// ---------- ADMIN: бүтээгдэхүүн удирдах (PIN шаардана) ----------
// Бүх бүтээгдэхүүн (дууссан/идэвхгүй зүйлийг оруулаад) харах
app.get('/api/admin/products', requireCourierPin, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY id').all();
  res.json(products);
});

// Шинэ бүтээгдэхүүн нэмэх
app.post('/api/admin/products', requireCourierPin, (req, res) => {
  const { name, category, unit, price, emoji, color } = req.body || {};
  if (!name || !category || !unit || !price) {
    return res.status(400).json({ error: 'name, category, unit, price шаардлагатай' });
  }
  const info = db.prepare(`
    INSERT INTO products (name, category, unit, price, emoji, color, active)
    VALUES (?, ?, ?, ?, ?, ?, 1)
  `).run(name, category, unit, Math.round(price), emoji || '🥬', color || '#c9e0a6');
  const created = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

// Бүтээгдэхүүн засах — "дууссан" гэж тэмдэглэх (active=0), сэргээх (active=1), үнэ/нэр өөрчлөх
app.patch('/api/admin/products/:id', requireCourierPin, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Бүтээгдэхүүн олдсонгүй' });

  const fields = ['name', 'category', 'unit', 'price', 'emoji', 'color', 'active'];
  const updates = {};
  for (const f of fields) {
    if (req.body[f] !== undefined) updates[f] = req.body[f];
  }
  const merged = { ...existing, ...updates };
  db.prepare(`
    UPDATE products SET name=?, category=?, unit=?, price=?, emoji=?, color=?, active=? WHERE id=?
  `).run(merged.name, merged.category, merged.unit, Math.round(merged.price), merged.emoji, merged.color, merged.active ? 1 : 0, req.params.id);

  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// Бүтээгдэхүүн бүрмөсөн устгах
app.delete('/api/admin/products/:id', requireCourierPin, (req, res) => {
  const existing = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Бүтээгдэхүүн олдсонгүй' });
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ deleted: true });
});

// ---------- CREATE ORDER ----------
// body: { customerName, phone, address, note, items: [{productId, qty}] }
app.post('/api/orders', async (req, res) => {
  const { customerName, phone, address, note, items } = req.body || {};

  if (!customerName || !phone || !address) {
    return res.status(400).json({ error: 'customerName, phone, address шаардлагатай' });
  }
  if (!/дархан/i.test(address)) {
    return res.status(400).json({ error: 'Уучлаарай, одоогоор зөвхөн Дархан хотод хүргэлт хийж байна.' });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'Сагс хоосон байна' });
  }

  const productStmt = db.prepare('SELECT * FROM products WHERE id = ? AND active = 1');
  const resolvedItems = [];
  let total = 0;
  for (const it of items) {
    const p = productStmt.get(it.productId);
    if (!p) return res.status(400).json({ error: `Бүтээгдэхүүн олдсонгүй: ${it.productId}` });
    const qty = Math.max(1, parseInt(it.qty, 10) || 1);
    total += p.price * qty;
    resolvedItems.push({ ...p, qty });
  }

  const orderNumber = generateOrderNumber();

  const insertOrder = db.prepare(`
    INSERT INTO orders (order_number, customer_name, phone, address, note, total)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertItem = db.prepare(`
    INSERT INTO order_items (order_id, product_id, name, unit, price, qty)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let orderId;
  const tx = db.transaction(() => {
    const info = insertOrder.run(orderNumber, customerName, phone, address, note || '', total);
    orderId = info.lastInsertRowid;
    for (const it of resolvedItems) {
      insertItem.run(orderId, it.id, it.name, it.unit, it.price, it.qty);
    }
    logStatus(orderId, 'RECEIVED');
  });
  tx();

  // Захиалга орж ирмэгц Telegram руу мэдэгдэл илгээнэ (тохируулагдсан бол).
  telegram.notifyNewOrder({
    orderNumber,
    customerName,
    phone,
    address,
    note,
    total,
    items: resolvedItems,
  });

  // Try to create a real QPay invoice if credentials are configured.
  let payment = { configured: false };
  if (qpay.credentialsConfigured()) {
    try {
      const invoice = await qpay.createInvoice({
        orderNumber,
        amount: total,
        description: `ХӨРС захиалга ${orderNumber}`,
        customerPhone: phone,
      });
      db.prepare('UPDATE orders SET qpay_invoice_id = ?, qpay_qr_text = ?, qpay_qr_image = ? WHERE id = ?')
        .run(invoice.invoice_id, invoice.qr_text, invoice.qr_image, orderId);
      payment = {
        configured: true,
        invoiceId: invoice.invoice_id,
        qrText: invoice.qr_text,
        qrImage: invoice.qr_image,
        deeplinks: invoice.deeplinks,
      };
    } catch (err) {
      console.error('[qpay] invoice creation failed:', err.message);
      payment = { configured: true, error: 'QPay нэхэмжлэх үүсгэхэд алдаа гарлаа' };
    }
  }

  res.status(201).json({ orderNumber, total, status: 'RECEIVED', payment });
});

// ---------- TRACK ORDER ----------
app.get('/api/orders/:orderNumber/track', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(req.params.orderNumber);
  if (!order) return res.status(404).json({ error: 'Захиалга олдсонгүй' });

  const log = db.prepare('SELECT status, created_at FROM order_status_log WHERE order_id = ? ORDER BY id').all(order.id);
  const items = db.prepare('SELECT name, unit, price, qty FROM order_items WHERE order_id = ?').all(order.id);

  res.json({
    orderNumber: order.order_number,
    status: order.status,
    paymentStatus: order.payment_status,
    total: order.total,
    createdAt: order.created_at,
    updatedAt: order.updated_at,
    statusFlow: STATUS_FLOW,
    history: log,
    items,
  });
});

// ---------- ADVANCE ORDER STATUS (хүргэгч / админ ашиглана — PIN шаардана) ----------
app.post('/api/orders/:orderNumber/advance', requireCourierPin, (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(req.params.orderNumber);
  if (!order) return res.status(404).json({ error: 'Захиалга олдсонгүй' });

  const idx = STATUS_FLOW.indexOf(order.status);
  if (idx === -1 || idx === STATUS_FLOW.length - 1) {
    return res.json({ orderNumber: order.order_number, status: order.status, done: true });
  }
  const next = STATUS_FLOW[idx + 1];
  logStatus(order.id, next);
  res.json({ orderNumber: order.order_number, status: next, done: next === STATUS_FLOW[STATUS_FLOW.length - 1] });
});

// ---------- LIST ORDERS (энгийн админ харах — PIN шаардана) ----------
app.get('/api/admin/orders', requireCourierPin, (req, res) => {
  const orders = db.prepare('SELECT order_number, customer_name, phone, total, status, payment_status, created_at FROM orders ORDER BY id DESC LIMIT 200').all();
  res.json(orders);
});

// ---------- COURIER: хүргэгдээгүй захиалгуудын жагсаалт (дэлгэрэнгүйтэй) ----------
app.get('/api/courier/orders', requireCourierPin, (req, res) => {
  const orders = db.prepare(`
    SELECT id, order_number, customer_name, phone, address, note, total, status, payment_status, created_at
    FROM orders
    WHERE status != 'DELIVERED'
    ORDER BY created_at ASC
  `).all();

  const itemsStmt = db.prepare('SELECT name, unit, price, qty FROM order_items WHERE order_id = ?');
  const withItems = orders.map((o) => ({
    orderNumber: o.order_number,
    customerName: o.customer_name,
    phone: o.phone,
    address: o.address,
    note: o.note,
    total: o.total,
    status: o.status,
    paymentStatus: o.payment_status,
    createdAt: o.created_at,
    items: itemsStmt.all(o.id),
  }));

  res.json({ statusFlow: STATUS_FLOW, orders: withItems });
});

// ---------- QPAY CALLBACK ----------
// QPay calls this URL (set as QPAY_CALLBACK_URL) once a customer pays the invoice QR.
app.post('/api/qpay/callback', async (req, res) => {
  const orderNumber = req.query.order;
  const order = db.prepare('SELECT * FROM orders WHERE order_number = ?').get(orderNumber);
  if (!order) return res.status(404).end();

  try {
    const paid = order.qpay_invoice_id ? await qpay.checkPayment(order.qpay_invoice_id) : false;
    if (paid) {
      db.prepare("UPDATE orders SET payment_status = 'PAID', updated_at = datetime('now') WHERE id = ?").run(order.id);
      if (order.status === 'RECEIVED') logStatus(order.id, 'PICKING');
    }
  } catch (err) {
    console.error('[qpay callback] verify failed:', err.message);
  }
  res.status(200).end();
});

app.listen(PORT, () => {
  console.log(`ХӨРС сервер http://localhost:${PORT} дээр ажиллаж байна`);
  console.log(`QPay тохиргоо: ${qpay.credentialsConfigured() ? 'холбогдсон' : 'тохируулаагүй (.env үзнэ үү)'}`);
  console.log(`Telegram мэдэгдэл: ${telegram.configured() ? 'холбогдсон' : 'тохируулаагүй (.env үзнэ үү)'}`);
});
