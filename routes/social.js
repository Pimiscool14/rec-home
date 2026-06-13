const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');
const { sendToUser } = require('../websocket');

const router = express.Router();

// ==================== CHAT ====================

// Get private messages with a user
router.get('/chat/:userId', isAuthenticated, (req, res) => {
  const otherId = parseInt(req.params.userId);
  const page = parseInt(req.query.page) || 1;
  const limit = 50;

  const messages = db.prepare(`
    SELECT m.*, u.username as sender_name FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
      AND m.room_id IS NULL
    ORDER BY m.created_at DESC LIMIT ? OFFSET ?
  `).all(req.user.id, otherId, otherId, req.user.id, limit, (page - 1) * limit);

  // Mark as read
  db.prepare('UPDATE messages SET is_read = 1 WHERE recipient_id = ? AND sender_id = ? AND is_read = 0')
    .run(req.user.id, otherId);

  res.json({ messages: messages.reverse(), page });
});

// Get room chat messages
router.get('/chat/room/:roomId', isAuthenticated, (req, res) => {
  const limit = 50;
  const messages = db.prepare(`
    SELECT m.*, u.username as sender_name FROM messages m
    JOIN users u ON m.sender_id = u.id
    WHERE m.room_id = ?
    ORDER BY m.created_at DESC LIMIT ?
  `).all(parseInt(req.params.roomId), limit);

  res.json({ messages: messages.reverse() });
});

// Get recent conversations
router.get('/conversations', isAuthenticated, (req, res) => {
  const conversations = db.prepare(`
    SELECT DISTINCT
      CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END as other_user_id,
      u.username, u.display_name, u.avatar_url,
      (SELECT content FROM messages m2
       WHERE ((m2.sender_id = m.sender_id AND m2.recipient_id = m.recipient_id)
          OR (m2.sender_id = m.recipient_id AND m2.recipient_id = m.sender_id))
         AND m2.room_id IS NULL
       ORDER BY m2.created_at DESC LIMIT 1) as last_message,
      (SELECT created_at FROM messages m2
       WHERE ((m2.sender_id = m.sender_id AND m2.recipient_id = m.recipient_id)
          OR (m2.sender_id = m.recipient_id AND m2.recipient_id = m.sender_id))
         AND m2.room_id IS NULL
       ORDER BY m2.created_at DESC LIMIT 1) as last_time,
      (SELECT COUNT(*) FROM messages m3 WHERE m3.sender_id = u.id AND m3.recipient_id = ? AND m3.is_read = 0) as unread
    FROM messages m
    JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.recipient_id ELSE m.sender_id END
    WHERE (m.sender_id = ? OR m.recipient_id = ?) AND m.room_id IS NULL
    ORDER BY last_time DESC
  `).all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);

  res.json({ conversations });
});

// ==================== BLOCKED USERS ====================

router.get('/blocked', isAuthenticated, (req, res) => {
  const blocked = db.prepare(`
    SELECT b.*, u.username, u.display_name, u.avatar_url FROM blocked_users b
    JOIN users u ON b.blocked_user_id = u.id
    WHERE b.user_id = ?
  `).all(req.user.id);
  res.json({ blocked });
});

router.post('/block/:userId', isAuthenticated, (req, res) => {
  const targetId = parseInt(req.params.userId);
  if (targetId === req.user.id) return res.status(400).json({ error: 'Cannot block yourself.' });

  db.prepare('INSERT OR IGNORE INTO blocked_users (user_id, blocked_user_id, reason) VALUES (?, ?, ?)')
    .run(req.user.id, targetId, req.body.reason || '');

  // Remove friend if exists
  db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
    .run(req.user.id, targetId, targetId, req.user.id);

  res.json({ success: true, message: 'User blocked.' });
});

router.post('/unblock/:userId', isAuthenticated, (req, res) => {
  db.prepare('DELETE FROM blocked_users WHERE user_id = ? AND blocked_user_id = ?')
    .run(req.user.id, parseInt(req.params.userId));
  res.json({ success: true, message: 'User unblocked.' });
});

// ==================== NOTIFICATIONS ====================

router.get('/notifications', isAuthenticated, (req, res) => {
  const notifications = db.prepare(`
    SELECT n.*, u.username as from_username FROM notifications n
    LEFT JOIN users u ON n.from_user_id = u.id
    WHERE n.user_id = ?
    ORDER BY n.created_at DESC LIMIT 50
  `).all(req.user.id);
  res.json({ notifications });
});

router.post('/notifications/read/:id', isAuthenticated, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?')
    .run(parseInt(req.params.id), req.user.id);
  res.json({ success: true });
});

router.post('/notifications/read-all', isAuthenticated, (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ success: true });
});

function createNotification(userId, type, title, body, link, fromUserId) {
  const result = db.prepare(
    'INSERT INTO notifications (user_id, type, title, body, link, from_user_id) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(userId, type, title, body, link || null, fromUserId || null);

  // Send via WebSocket if online
  sendToUser(userId, {
    type: 'notification',
    id: result.lastInsertRowid,
    notificationType: type,
    title, body, link,
    fromUserId,
    createdAt: new Date().toISOString(),
  });
}

module.exports = { router, createNotification };
