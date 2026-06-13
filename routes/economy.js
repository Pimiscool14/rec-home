const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== STORE ====================

router.get('/store', (req, res) => {
  const { category, search, sort, page = 1 } = req.query;
  const limit = 20;
  let query = 'SELECT * FROM store_items WHERE is_active = 1';
  const params = [];

  if (category) { query += ' AND category = ?'; params.push(category); }
  if (search) { query += ' AND (name LIKE ? OR description LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }

  const countQuery = query.replace('SELECT *', 'SELECT COUNT(*) as count');
  const total = db.prepare(countQuery).get(...params).count;

  query += ' ORDER BY ' + (sort === 'price_asc' ? 'price ASC' : sort === 'price_desc' ? 'price DESC' : 'id ASC');
  query += ' LIMIT ? OFFSET ?';
  params.push(limit, (parseInt(page) - 1) * limit);

  const items = db.prepare(query).all(...params);
  res.json({ items, page: parseInt(page), totalPages: Math.ceil(total / limit), total });
});

router.get('/store/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM store_items WHERE id = ?').get(parseInt(req.params.id));
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  res.json({ item });
});

// ==================== INVENTORY ====================

router.get('/inventory', isAuthenticated, (req, res) => {
  const items = db.prepare(`
    SELECT i.*, s.name, s.description, s.category, s.rarity, s.image_url
    FROM inventory_items i
    JOIN store_items s ON i.item_id = s.id
    WHERE i.user_id = ?
    ORDER BY i.acquired_at DESC
  `).all(req.user.id);
  res.json({ items });
});

router.post('/inventory/equip/:itemId', isAuthenticated, (req, res) => {
  const itemId = parseInt(req.params.itemId);

  // Check user owns this item
  const owned = db.prepare('SELECT * FROM inventory_items WHERE user_id = ? AND item_id = ?')
    .get(req.user.id, itemId);
  if (!owned) return res.status(404).json({ error: 'You do not own this item.' });

  // Get item category
  const item = db.prepare('SELECT category FROM store_items WHERE id = ?').get(itemId);

  // Unequip other items in same category
  if (item) {
    db.prepare(`
      UPDATE inventory_items SET is_equipped = 0
      WHERE user_id = ? AND item_id IN (SELECT id FROM store_items WHERE category = ?)
    `).run(req.user.id, item.category);
  }

  // Equip this item
  db.prepare('UPDATE inventory_items SET is_equipped = 1 WHERE user_id = ? AND item_id = ?')
    .run(req.user.id, itemId);

  res.json({ success: true, message: 'Item equipped.' });
});

router.post('/inventory/unequip/:itemId', isAuthenticated, (req, res) => {
  db.prepare('UPDATE inventory_items SET is_equipped = 0 WHERE user_id = ? AND item_id = ?')
    .run(req.user.id, parseInt(req.params.itemId));
  res.json({ success: true, message: 'Item unequipped.' });
});

// ==================== PURCHASES ====================

router.post('/store/purchase/:itemId', isAuthenticated, (req, res) => {
  const itemId = parseInt(req.params.itemId);
  const item = db.prepare('SELECT * FROM store_items WHERE id = ? AND is_active = 1').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found.' });

  // Check if already owned
  const owned = db.prepare('SELECT * FROM inventory_items WHERE user_id = ? AND item_id = ?')
    .get(req.user.id, itemId);
  if (owned) return res.status(400).json({ error: 'You already own this item.' });

  // Check currency balance
  const currencyField = item.currency_type === 'tokens' ? 'tokens' : item.currency_type;
  const user = db.prepare('SELECT tokens FROM users WHERE id = ?').get(req.user.id);

  if (user.tokens < item.price) {
    return res.status(400).json({ error: `Not enough ${item.currency_type}. You have ${user.tokens}, need ${item.price}.` });
  }

  // Deduct currency
  db.prepare('UPDATE users SET tokens = tokens - ? WHERE id = ?').run(item.price, req.user.id);

  // Add to inventory
  db.prepare('INSERT INTO inventory_items (user_id, item_id) VALUES (?, ?)').run(req.user.id, itemId);

  // Record purchase
  db.prepare('INSERT INTO purchases (user_id, item_id, price_paid, currency_type) VALUES (?, ?, ?, ?)')
    .run(req.user.id, itemId, item.price, item.currency_type);

  // Record transaction
  db.prepare('INSERT INTO currency_transactions (user_id, amount, currency_type, reason) VALUES (?, ?, ?, ?)')
    .run(req.user.id, -item.price, item.currency_type, `Purchased ${item.name}`);

  res.json({ success: true, message: `Purchased ${item.name}!`, remainingTokens: user.tokens - item.price });
});

// ==================== CURRENCY ====================

router.get('/currency', isAuthenticated, (req, res) => {
  const user = db.prepare('SELECT tokens FROM users WHERE id = ?').get(req.user.id);
  const transactions = db.prepare(
    'SELECT * FROM currency_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 30'
  ).all(req.user.id);
  res.json({ tokens: user.tokens, transactions });
});

// ==================== PURCHASE HISTORY ====================

router.get('/purchases', isAuthenticated, (req, res) => {
  const purchases = db.prepare(`
    SELECT p.*, s.name as item_name, s.category, s.rarity FROM purchases p
    JOIN store_items s ON p.item_id = s.id
    WHERE p.user_id = ?
    ORDER BY p.created_at DESC LIMIT 30
  `).all(req.user.id);
  res.json({ purchases });
});

module.exports = router;
