const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== Search Users ====================
router.get('/search', isAuthenticated, (req, res) => {
  const query = req.query.q || '';
  if (query.length < 2) {
    return res.json({ users: [] });
  }

  const users = db.prepare(`
    SELECT id, username, display_name, avatar_url, level, role
    FROM users
    WHERE (username LIKE ? OR display_name LIKE ?) AND id != ?
    LIMIT 20
  `).all(`%${query}%`, `%${query}%`, req.user.id);

  res.json({ users });
});

// ==================== Send Friend Request ====================
router.post('/request/:id', isAuthenticated, (req, res) => {
  const friendId = parseInt(req.params.id);

  if (friendId === req.user.id) {
    return res.status(400).json({ error: "You can't friend yourself." });
  }

  const targetUser = db.prepare('SELECT id FROM users WHERE id = ?').get(friendId);
  if (!targetUser) {
    return res.status(404).json({ error: 'User not found.' });
  }

  // Check existing friendship
  const existing = db.prepare(
    'SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  ).get(req.user.id, friendId, friendId, req.user.id);

  if (existing) {
    if (existing.status === 'accepted') {
      return res.status(400).json({ error: 'Already friends.' });
    }
    if (existing.status === 'blocked') {
      return res.status(400).json({ error: 'Cannot send request.' });
    }
    if (existing.user_id === req.user.id && existing.status === 'pending') {
      return res.status(400).json({ error: 'Friend request already sent.' });
    }
    // If the other person sent us a pending request, accept it
    if (existing.friend_id === req.user.id && existing.status === 'pending') {
      db.prepare('UPDATE friends SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
        .run('accepted', existing.id);
      return res.json({ success: true, message: 'Friend request accepted!' });
    }
  }

  db.prepare('INSERT INTO friends (user_id, friend_id, status) VALUES (?, ?, ?)')
    .run(req.user.id, friendId, 'pending');

  res.json({ success: true, message: 'Friend request sent!' });
});

// ==================== Accept Friend Request ====================
router.post('/accept/:id', isAuthenticated, (req, res) => {
  const requestId = parseInt(req.params.id);

  const request = db.prepare(
    'SELECT * FROM friends WHERE id = ? AND friend_id = ? AND status = ?'
  ).get(requestId, req.user.id, 'pending');

  if (!request) {
    return res.status(404).json({ error: 'Friend request not found.' });
  }

  db.prepare('UPDATE friends SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('accepted', requestId);

  res.json({ success: true, message: 'Friend request accepted!' });
});

// ==================== Decline / Remove Friend ====================
router.post('/decline/:id', isAuthenticated, (req, res) => {
  const requestId = parseInt(req.params.id);

  db.prepare('DELETE FROM friends WHERE id = ? AND (user_id = ? OR friend_id = ?)')
    .run(requestId, req.user.id, req.user.id);

  res.json({ success: true, message: 'Friend removed.' });
});

router.post('/remove/:id', isAuthenticated, (req, res) => {
  const friendId = parseInt(req.params.id);

  db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)')
    .run(req.user.id, friendId, friendId, req.user.id);

  res.json({ success: true, message: 'Friend removed.' });
});

// ==================== List Friends ====================
router.get('/list', isAuthenticated, (req, res) => {
  const friends = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.level, u.role,
           f.created_at as friends_since, f.id as friendship_id
    FROM friends f
    JOIN users u ON (f.user_id = u.id OR f.friend_id = u.id) AND u.id != ?
    WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'
    ORDER BY u.username
  `).all(req.user.id, req.user.id, req.user.id);

  res.json({ friends });
});

// ==================== Pending Requests ====================
router.get('/pending', isAuthenticated, (req, res) => {
  // Incoming requests
  const incoming = db.prepare(`
    SELECT f.id as request_id, u.id as user_id, u.username, u.display_name, u.avatar_url, f.created_at
    FROM friends f
    JOIN users u ON f.user_id = u.id
    WHERE f.friend_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  // Outgoing requests
  const outgoing = db.prepare(`
    SELECT f.id as request_id, u.id as user_id, u.username, u.display_name, u.avatar_url, f.created_at
    FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.status = 'pending'
    ORDER BY f.created_at DESC
  `).all(req.user.id);

  res.json({ incoming, outgoing });
});

module.exports = router;
