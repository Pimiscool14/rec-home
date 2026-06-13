const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== Send Room Invite ====================
router.post('/send', isAuthenticated, (req, res) => {
  const { room_id, to_user_id, message } = req.body;

  if (!room_id || !to_user_id) {
    return res.status(400).json({ error: 'Room ID and user ID are required.' });
  }

  // Check room exists and user is member
  const membership = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(room_id, req.user.id);
  if (!membership) {
    return res.status(403).json({ error: 'You must be a member of the room to invite others.' });
  }

  // Check target user exists
  const target = db.prepare('SELECT id FROM users WHERE id = ?').get(to_user_id);
  if (!target) {
    return res.status(404).json({ error: 'User not found.' });
  }

  // Check not already a member
  const alreadyMember = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(room_id, to_user_id);
  if (alreadyMember) {
    return res.status(400).json({ error: 'User is already in this room.' });
  }

  // Check no existing pending invite
  const existing = db.prepare(
    'SELECT * FROM room_invites WHERE room_id = ? AND to_user_id = ? AND status = ?'
  ).get(room_id, to_user_id, 'pending');
  if (existing) {
    return res.status(400).json({ error: 'Invite already sent.' });
  }

  db.prepare('INSERT INTO room_invites (room_id, from_user_id, to_user_id, message) VALUES (?, ?, ?, ?)')
    .run(room_id, req.user.id, to_user_id, message || '');

  res.json({ success: true, message: 'Invite sent!' });
});

// ==================== Accept Invite ====================
router.post('/:id/accept', isAuthenticated, (req, res) => {
  const inviteId = parseInt(req.params.id);

  const invite = db.prepare(
    'SELECT * FROM room_invites WHERE id = ? AND to_user_id = ? AND status = ?'
  ).get(inviteId, req.user.id, 'pending');

  if (!invite) {
    return res.status(404).json({ error: 'Invite not found.' });
  }

  db.prepare('UPDATE room_invites SET status = ? WHERE id = ?').run('accepted', inviteId);

  // Auto-join room
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(invite.room_id);
  if (room) {
    const alreadyMember = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
      .get(invite.room_id, req.user.id);
    if (!alreadyMember) {
      const count = db.prepare('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?').get(invite.room_id).count;
      if (count < room.max_members) {
        db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(invite.room_id, req.user.id);
        db.prepare('UPDATE rooms SET member_count = member_count + 1 WHERE id = ?').run(invite.room_id);
      }
    }
  }

  res.json({ success: true, message: 'Invite accepted!' });
});

// ==================== Decline Invite ====================
router.post('/:id/decline', isAuthenticated, (req, res) => {
  const inviteId = parseInt(req.params.id);

  db.prepare('UPDATE room_invites SET status = ? WHERE id = ? AND to_user_id = ?')
    .run('declined', inviteId, req.user.id);

  res.json({ success: true, message: 'Invite declined.' });
});

// ==================== My Pending Invites ====================
router.get('/pending', isAuthenticated, (req, res) => {
  const invites = db.prepare(`
    SELECT ri.*, r.name as room_name, u.username as from_username, u.display_name as from_display
    FROM room_invites ri
    JOIN rooms r ON ri.room_id = r.id
    JOIN users u ON ri.from_user_id = u.id
    WHERE ri.to_user_id = ? AND ri.status = 'pending'
    ORDER BY ri.created_at DESC
  `).all(req.user.id);

  res.json({ invites });
});

module.exports = router;
