const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// Admin check middleware
function isAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

function isModOrAdmin(req, res, next) {
  if (!req.user || !['admin', 'mod'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Moderator access required.' });
  }
  next();
}

// ==================== REPORTS ====================

router.post('/report', isAuthenticated, (req, res) => {
  const { reported_user_id, reason, description } = req.body;
  if (!reported_user_id || !reason) {
    return res.status(400).json({ error: 'Reported user ID and reason required.' });
  }

  if (parseInt(reported_user_id) === req.user.id) {
    return res.status(400).json({ error: 'Cannot report yourself.' });
  }

  db.prepare(
    'INSERT INTO reports (reporter_id, reported_user_id, reason, description) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, parseInt(reported_user_id), reason, description || '');

  // Log moderation action
  db.prepare(
    'INSERT INTO moderation_logs (admin_id, target_user_id, action, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, parseInt(reported_user_id), 'report_filed', reason);

  res.json({ success: true, message: 'Report submitted. A moderator will review it.' });
});

router.get('/reports', isAuthenticated, isModOrAdmin, (req, res) => {
  const reports = db.prepare(`
    SELECT r.*, u1.username as reporter_name, u2.username as reported_name
    FROM reports r
    JOIN users u1 ON r.reporter_id = u1.id
    JOIN users u2 ON r.reported_user_id = u2.id
    ORDER BY r.created_at DESC LIMIT 100
  `).all();
  res.json({ reports });
});

router.post('/reports/:id/handle', isAuthenticated, isModOrAdmin, (req, res) => {
  const { action, reason } = req.body; // action: dismissed, warned, muted, banned

  db.prepare('UPDATE reports SET status = ?, handled_by = ?, handled_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(action || 'dismissed', req.user.id, parseInt(req.params.id));

  db.prepare(
    'INSERT INTO moderation_logs (admin_id, target_user_id, action, reason, details) VALUES (?, ?, ?, ?, ?)'
  ).run(req.user.id, req.body.target_user_id || null, `report_${action || 'dismissed'}`, reason || '', `Report #${req.params.id}`);

  res.json({ success: true, message: 'Report handled.' });
});

// ==================== MUTES ====================

router.post('/mute/:userId', isAuthenticated, isModOrAdmin, (req, res) => {
  const targetId = parseInt(req.params.userId);
  const { reason, duration_hours } = req.body;

  const expiresAt = duration_hours
    ? new Date(Date.now() + duration_hours * 3600000).toISOString()
    : null; // null = permanent

  db.prepare('INSERT INTO mutes (user_id, muted_by, reason, expires_at) VALUES (?, ?, ?, ?)')
    .run(targetId, req.user.id, reason || '', expiresAt);

  db.prepare(
    'INSERT INTO moderation_logs (admin_id, target_user_id, action, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, targetId, 'mute', reason || '');

  res.json({ success: true, message: `User muted for ${duration_hours || 'indefinitely'} hours.` });
});

router.post('/unmute/:userId', isAuthenticated, isModOrAdmin, (req, res) => {
  db.prepare('DELETE FROM mutes WHERE user_id = ?').run(parseInt(req.params.userId));
  res.json({ success: true, message: 'User unmuted.' });
});

// ==================== BANS ====================

router.post('/ban/:userId', isAuthenticated, isAdmin, (req, res) => {
  const targetId = parseInt(req.params.userId);
  const { reason } = req.body;

  db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(targetId);

  db.prepare(
    'INSERT INTO moderation_logs (admin_id, target_user_id, action, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, targetId, 'ban', reason || '');

  res.json({ success: true, message: 'User banned.' });
});

router.post('/unban/:userId', isAuthenticated, isAdmin, (req, res) => {
  db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(parseInt(req.params.userId));

  db.prepare(
    'INSERT INTO moderation_logs (admin_id, target_user_id, action, reason) VALUES (?, ?, ?, ?)'
  ).run(req.user.id, parseInt(req.params.userId), 'unban', '');

  res.json({ success: true, message: 'User unbanned.' });
});

// ==================== AUDIT LOGS ====================

router.get('/logs', isAuthenticated, isModOrAdmin, (req, res) => {
  const logs = db.prepare(`
    SELECT ml.*, u.username as admin_name, u2.username as target_name
    FROM moderation_logs ml
    JOIN users u ON ml.admin_id = u.id
    LEFT JOIN users u2 ON ml.target_user_id = u2.id
    ORDER BY ml.created_at DESC LIMIT 200
  `).all();
  res.json({ logs });
});

module.exports = router;
