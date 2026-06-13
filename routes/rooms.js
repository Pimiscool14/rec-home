const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== Create Room ====================
router.post('/create', isAuthenticated, (req, res) => {
  const { name, description, room_type, max_members } = req.body;

  if (!name || name.trim().length < 2) {
    return res.status(400).json({ error: 'Room name must be at least 2 characters.' });
  }

  const maxMembers = parseInt(req.body.max_members) || 20;

  const result = db.prepare(`
    INSERT INTO rooms (name, description, owner_id, room_type, max_members)
    VALUES (?, ?, ?, ?, ?)
  `).run(name.trim(), description || '', req.user.id, room_type || 'public', maxMembers);

  // Auto-join creator as owner
  db.prepare('INSERT INTO room_members (room_id, user_id, role) VALUES (?, ?, ?)')
    .run(result.lastInsertRowid, req.user.id, 'owner');

  res.json({
    success: true,
    room: {
      id: result.lastInsertRowid,
      name: name.trim(),
      description: description || '',
      room_type: room_type || 'public',
      owner_id: req.user.id,
    },
    message: 'Room created!',
  });
});

// ==================== Join Room ====================
router.post('/:id/join', isAuthenticated, (req, res) => {
  const roomId = parseInt(req.params.id);

  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (!room) {
    return res.status(404).json({ error: 'Room not found.' });
  }

  // Check if already a member
  const membership = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, req.user.id);
  if (membership) {
    return res.json({ success: true, message: 'Already in this room.' });
  }

  // Check room capacity
  const count = db.prepare('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?').get(roomId).count;
  if (count >= room.max_members) {
    return res.status(400).json({ error: 'Room is full.' });
  }

  // For private rooms, auto-accept pending invite or check accepted one
  if (room.room_type !== 'public') {
    const invite = db.prepare(
      'SELECT * FROM room_invites WHERE room_id = ? AND to_user_id = ? AND status IN (?, ?)'
    ).get(roomId, req.user.id, 'pending', 'accepted');
    if (!invite) {
      return res.status(403).json({ error: 'You need an invite to join this room.' });
    }
    // If invite was pending, auto-accept it
    if (invite.status === 'pending') {
      db.prepare('UPDATE room_invites SET status = ? WHERE id = ?').run('accepted', invite.id);
    }
  }

  db.prepare('INSERT INTO room_members (room_id, user_id) VALUES (?, ?)').run(roomId, req.user.id);
  db.prepare('UPDATE rooms SET member_count = member_count + 1 WHERE id = ?').run(roomId);

  res.json({ success: true, message: `Joined ${room.name}!` });
});

// ==================== Leave Room ====================
router.post('/:id/leave', isAuthenticated, (req, res) => {
  const roomId = parseInt(req.params.id);

  const membership = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, req.user.id);
  if (!membership) {
    return res.status(400).json({ error: "You're not in this room." });
  }

  if (membership.role === 'owner') {
    // Transfer ownership or delete room
    const otherMember = db.prepare(
      'SELECT * FROM room_members WHERE room_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1'
    ).get(roomId, req.user.id);

    if (otherMember) {
      db.prepare('UPDATE room_members SET role = ? WHERE id = ?').run('owner', otherMember.id);
      db.prepare('UPDATE rooms SET owner_id = ? WHERE id = ?').run(otherMember.user_id, roomId);
    }
  }

  db.prepare('DELETE FROM room_members WHERE id = ?').run(membership.id);
  db.prepare('UPDATE rooms SET member_count = MAX(0, member_count - 1) WHERE id = ?').run(roomId);

  // If no members left, mark inactive
  const remaining = db.prepare('SELECT COUNT(*) as count FROM room_members WHERE room_id = ?').get(roomId).count;
  if (remaining === 0) {
    db.prepare('UPDATE rooms SET is_active = 0 WHERE id = ?').run(roomId);
  }

  res.json({ success: true, message: 'Left the room.' });
});

// ==================== List Public Rooms ====================
router.get('/list', (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, u.username as owner_username, u.display_name as owner_display
    FROM rooms r
    JOIN users u ON r.owner_id = u.id
    WHERE r.is_active = 1
    ORDER BY r.member_count DESC, r.created_at DESC
    LIMIT 50
  `).all();

  res.json({ rooms });
});

// ==================== My Rooms ====================
router.get('/my', isAuthenticated, (req, res) => {
  const rooms = db.prepare(`
    SELECT r.*, rm.role as my_role,
           u.username as owner_username, u.display_name as owner_display
    FROM rooms r
    JOIN room_members rm ON r.id = rm.room_id
    JOIN users u ON r.owner_id = u.id
    WHERE rm.user_id = ? AND r.is_active = 1
    ORDER BY r.created_at DESC
  `).all(req.user.id);

  res.json({ rooms });
});

// ==================== Room Details ====================
router.get('/:id', (req, res) => {
  const roomId = parseInt(req.params.id);

  const room = db.prepare(`
    SELECT r.*, u.username as owner_username, u.display_name as owner_display, u.avatar_url as owner_avatar
    FROM rooms r
    JOIN users u ON r.owner_id = u.id
    WHERE r.id = ?
  `).get(roomId);

  if (!room) {
    return res.status(404).json({ error: 'Room not found.' });
  }

  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.level, rm.role, rm.joined_at
    FROM room_members rm
    JOIN users u ON rm.user_id = u.id
    WHERE rm.room_id = ?
    ORDER BY rm.joined_at
  `).all(roomId);

  const photos = db.prepare(
    'SELECT * FROM photos WHERE room_name = ? AND is_public = 1 ORDER BY created_at DESC LIMIT 12'
  ).all(room.name);

  res.json({ room, members, photos });
});

// ==================== Kick Member (owner only) ====================
router.post('/:roomId/kick/:userId', isAuthenticated, (req, res) => {
  const roomId = parseInt(req.params.roomId);
  const targetUserId = parseInt(req.params.userId);

  const membership = db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?')
    .get(roomId, req.user.id);
  if (!membership || membership.role !== 'owner') {
    return res.status(403).json({ error: 'Only room owners can kick members.' });
  }

  if (targetUserId === req.user.id) {
    return res.status(400).json({ error: 'Cannot kick yourself. Use leave instead.' });
  }

  db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, targetUserId);
  db.prepare('UPDATE rooms SET member_count = MAX(0, member_count - 1) WHERE id = ?').run(roomId);

  res.json({ success: true, message: 'Member kicked.' });
});

// ==================== Delete Room (owner only) ====================
router.delete('/:id', isAuthenticated, (req, res) => {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ? AND owner_id = ?')
    .get(parseInt(req.params.id), req.user.id);

  if (!room) {
    return res.status(404).json({ error: 'Room not found or not yours.' });
  }

  db.prepare('UPDATE rooms SET is_active = 0 WHERE id = ?').run(room.id);
  res.json({ success: true, message: 'Room deleted.' });
});

module.exports = router;
