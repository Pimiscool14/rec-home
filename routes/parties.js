const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');
const { createNotification } = require('./social');

const router = express.Router();

// Create party
router.post('/create', isAuthenticated, (req, res) => {
  const { name, max_size } = req.body;

  // Check not already in a party
  const existingMember = db.prepare(`
    SELECT p.id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.user_id = ?
  `).get(req.user.id);
  if (existingMember) return res.status(400).json({ error: 'Already in a party. Leave first.' });

  const result = db.prepare(
    'INSERT INTO parties (name, leader_id, max_size) VALUES (?, ?, ?)'
  ).run(name || `${req.user.username}'s Party`, req.user.id, max_size || 4);

  db.prepare('INSERT INTO party_members (party_id, user_id, role) VALUES (?, ?, ?)')
    .run(result.lastInsertRowid, req.user.id, 'leader');

  res.json({ success: true, party: { id: result.lastInsertRowid, name: name || `${req.user.username}'s Party`, leader_id: req.user.id, max_size: max_size || 4 } });
});

// Join party (by party ID or invite)
router.post('/join/:partyId', isAuthenticated, (req, res) => {
  const partyId = parseInt(req.params.partyId);
  const party = db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId);
  if (!party) return res.status(404).json({ error: 'Party not found.' });

  const memberCount = db.prepare('SELECT COUNT(*) as count FROM party_members WHERE party_id = ?').get(partyId).count;
  if (memberCount >= party.max_size) return res.status(400).json({ error: 'Party is full.' });

  const already = db.prepare('SELECT * FROM party_members WHERE party_id = ? AND user_id = ?').get(partyId, req.user.id);
  if (already) return res.json({ success: true, message: 'Already in this party.' });

  // Check blocked
  const blocked = db.prepare('SELECT id FROM blocked_users WHERE (user_id = ? AND blocked_user_id = ?) OR (user_id = ? AND blocked_user_id = ?)')
    .get(req.user.id, party.leader_id, party.leader_id, req.user.id);
  if (blocked) return res.status(403).json({ error: 'Cannot join this party.' });

  db.prepare('INSERT INTO party_members (party_id, user_id) VALUES (?, ?)').run(partyId, req.user.id);
  res.json({ success: true, message: 'Joined party.' });
});

// Leave party
router.post('/leave', isAuthenticated, (req, res) => {
  const membership = db.prepare(`
    SELECT pm.*, p.leader_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.user_id = ?
  `).get(req.user.id);
  if (!membership) return res.status(400).json({ error: 'Not in a party.' });

  db.prepare('DELETE FROM party_members WHERE id = ?').run(membership.id);

  const remaining = db.prepare('SELECT COUNT(*) as count FROM party_members WHERE party_id = ?').get(membership.party_id).count;

  if (remaining === 0) {
    db.prepare('DELETE FROM parties WHERE id = ?').run(membership.party_id);
  } else if (membership.role === 'leader') {
    // Transfer leadership
    const next = db.prepare('SELECT * FROM party_members WHERE party_id = ? AND user_id != ? ORDER BY joined_at LIMIT 1')
      .get(membership.party_id, req.user.id);
    if (next) {
      db.prepare('UPDATE party_members SET role = ? WHERE id = ?').run('leader', next.id);
      db.prepare('UPDATE parties SET leader_id = ? WHERE id = ?').run(next.user_id, membership.party_id);
    }
  }

  res.json({ success: true, message: 'Left party.' });
});

// Invite to party
router.post('/invite/:userId', isAuthenticated, (req, res) => {
  const targetId = parseInt(req.params.userId);
  const membership = db.prepare(`
    SELECT pm.*, p.leader_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.user_id = ?
  `).get(req.user.id);
  if (!membership) return res.status(400).json({ error: 'You are not in a party.' });

  createNotification(targetId, 'party_invite', 'Party Invite',
    `${req.user.username} invited you to their party`,
    `/parties/${membership.party_id}`, req.user.id);

  res.json({ success: true, message: 'Invite sent.' });
});

// Kick from party
router.post('/kick/:userId', isAuthenticated, (req, res) => {
  const targetId = parseInt(req.params.userId);
  const membership = db.prepare(`
    SELECT pm.*, p.leader_id FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.user_id = ?
  `).get(req.user.id);
  if (!membership || membership.role !== 'leader') return res.status(403).json({ error: 'Only party leaders can kick.' });

  db.prepare('DELETE FROM party_members WHERE party_id = ? AND user_id = ?')
    .run(membership.party_id, targetId);

  res.json({ success: true, message: 'Member kicked.' });
});

// My party
router.get('/my', isAuthenticated, (req, res) => {
  const membership = db.prepare(`
    SELECT pm.*, p.name, p.leader_id, p.max_size
    FROM party_members pm JOIN parties p ON pm.party_id = p.id WHERE pm.user_id = ?
  `).get(req.user.id);
  if (!membership) return res.json({ party: null });

  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.avatar_url, u.level, pm.role
    FROM party_members pm JOIN users u ON pm.user_id = u.id WHERE pm.party_id = ?
  `).all(membership.party_id);

  res.json({ party: { ...membership, members } });
});

module.exports = router;
