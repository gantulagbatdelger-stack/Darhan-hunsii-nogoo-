// telegram.js — шинэ захиалга ирэх бүрд Telegram-руу мэдэгдэл илгээнэ.
//
// Тохируулах алхмууд (README-д дэлгэрэнгүй):
//   1. Telegram дээр @BotFather-тэй чатлаж, /newbot командаар шинэ бот үүсгээд TOKEN аваарай
//   2. Тухайн бот руугаа "/start" гэж бичээрэй (эсвэл группд нэмээрэй)
//   3. Chat ID-гаа олохын тулд @userinfobot ашиглах эсвэл README-ийн зааврыг дагана уу
//   4. .env дотор TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID-г бөглөнө
//
// Хэрэв эдгээр орчны хувьсагч тохируулаагүй бол мэдэгдэл дуудагдахгүй, алдаа гаргахгүй.

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

const configured = () => Boolean(BOT_TOKEN && CHAT_ID);

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(n) {
  return Number(n).toLocaleString('en-US') + ' ₮';
}

/** Шинэ захиалга ирэхэд дуудагдана. Алдаа гарвал зөвхөн console-д бичээд өнгөрнө (захиалга унтрахгүй). */
async function notifyNewOrder({ orderNumber, customerName, phone, address, note, total, items }) {
  if (!configured()) return;

  const itemLines = items.map((it) => `• ${escapeHtml(it.name)} — ${it.qty} ${it.unit} (${money(it.price * it.qty)})`).join('\n');

  const text =
    `🥕 <b>Шинэ захиалга ирлээ!</b>\n\n` +
    `<b>${escapeHtml(orderNumber)}</b>\n` +
    `👤 ${escapeHtml(customerName)}\n` +
    `📞 ${escapeHtml(phone)}\n` +
    `📍 ${escapeHtml(address)}\n` +
    (note ? `📝 ${escapeHtml(note)}\n` : '') +
    `\n${itemLines}\n\n` +
    `💰 Нийт: <b>${money(total)}</b>`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error('[telegram] send failed:', res.status, await res.text());
    }
  } catch (err) {
    console.error('[telegram] send error:', err.message);
  }
}

module.exports = { notifyNewOrder, configured };
