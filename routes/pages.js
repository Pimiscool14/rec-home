const express = require('express');
const { isAuthenticated, setUserLocals } = require('../middleware/auth');
const db = require('../database/db');

const router = express.Router();

// ==================== Landing Page ====================
router.get('/', setUserLocals, (req, res) => {
  res.render('index', { title: 'Rec Home - Your Rec Room Companion' });
});

// ==================== Dashboard ====================
router.get('/dashboard', isAuthenticated, setUserLocals, (req, res) => {
  const stats = {
    totalCommands: db.prepare('SELECT COUNT(*) as count FROM command_logs WHERE user_id = ?').get(req.user.id).count,
    totalPhotos: db.prepare('SELECT COUNT(*) as count FROM photos WHERE user_id = ?').get(req.user.id).count,
    totalFriends: db.prepare(
      'SELECT COUNT(*) as count FROM friends WHERE (user_id = ? OR friend_id = ?) AND status = ?'
    ).get(req.user.id, req.user.id, 'accepted').count,
    totalRooms: db.prepare('SELECT COUNT(*) as count FROM room_members WHERE user_id = ?').get(req.user.id).count,
    pendingInvites: db.prepare(
      'SELECT COUNT(*) as count FROM room_invites WHERE to_user_id = ? AND status = ?'
    ).get(req.user.id, 'pending').count,
    pendingFriends: db.prepare(
      'SELECT COUNT(*) as count FROM friends WHERE friend_id = ? AND status = ?'
    ).get(req.user.id, 'pending').count,
    recentCommands: db.prepare(
      'SELECT command, args, room_name, created_at FROM command_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 8'
    ).all(req.user.id),
    recentPhotos: db.prepare(
      'SELECT * FROM photos WHERE user_id = ? ORDER BY created_at DESC LIMIT 4'
    ).all(req.user.id),
    apiKeys: db.prepare('SELECT COUNT(*) as count FROM api_keys WHERE user_id = ?').get(req.user.id).count,
    settings: db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id) || {},
  };

  res.render('dashboard', { title: 'Dashboard - Rec Home', stats });
});

// ==================== Gallery Page ====================
router.get('/gallery', setUserLocals, (req, res) => {
  res.render('gallery', { title: '📸 Gallery - Rec Home' });
});

// ==================== Friends Page ====================
router.get('/friends', setUserLocals, (req, res) => {
  res.render('friends', { title: '👥 Friends - Rec Home' });
});

// ==================== Rooms Page ====================
router.get('/rooms', setUserLocals, (req, res) => {
  res.render('rooms', { title: '🏠 Rooms - Rec Home' });
});

// ==================== Features Page ====================
router.get('/features', setUserLocals, (req, res) => {
  res.render('features', { title: 'Features - Rec Home' });
});

// ==================== Download Page ====================
router.get('/download', setUserLocals, (req, res) => {
  res.render('download', { title: 'Download - Rec Home' });
});

// ==================== Docs / Commands Page ====================
router.get('/commands', setUserLocals, (req, res) => {
  const commands = [
    { name: 'help', desc: 'Show all commands', args: '', category: 'General' },
    { name: 'fly', desc: 'Toggle flight mode', args: '', category: 'Movement' },
    { name: 'esp', desc: 'Toggle ESP/wallhacks', args: '', category: 'Visual' },
    { name: 'espcolor', desc: 'Change ESP color', args: '[r, g, b]', category: 'Visual' },
    { name: 'espsize', desc: 'Change ESP label size', args: '[size]', category: 'Visual' },
    { name: 'spawn', desc: 'Spawn any game object', args: '[prefab, scale, distance, rotation]', category: 'Spawning' },
    { name: 'gift', desc: 'Spawn a gift box', args: '[type, looks, currency, text, amount, rarity]', category: 'Spawning' },
    { name: 'steal', desc: 'Steal objects from other players', args: '', category: 'Objects' },
    { name: 'buff', desc: 'Buff held weapons', args: '', category: 'Combat' },
    { name: 'ggs', desc: 'Insta-kill quest enemies', args: '', category: 'Combat' },
    { name: 'kick', desc: 'Kick a player', args: '[player_id]', category: 'Players' },
    { name: 'despawn', desc: 'Despawn a player', args: '[player_id]', category: 'Players' },
    { name: 'crash', desc: 'Crash other players (risky)', args: '', category: 'Players' },
    { name: 'party', desc: 'Force party invite', args: '[player_id]', category: 'Social' },
    { name: 'announce', desc: 'Send announcement', args: '[message]', category: 'Social' },
    { name: 'spamchat', desc: 'Spam chat messages', args: '[message, target, delay]', category: 'Social' },
    { name: 'recolor', desc: 'Recolor held items', args: '[r, g, b, side]', category: 'Objects' },
    { name: 'resizeheld', desc: 'Resize held object', args: '[amount]', category: 'Objects' },
    { name: 'destroyall', desc: 'Destroy all objects', args: '', category: 'Objects' },
    { name: 'thirdperson', desc: 'Force third person view', args: '', category: 'Visual' },
    { name: 'headscale', desc: 'Change head size', args: '[size]', category: 'Visual' },
    { name: 'showid', desc: 'Show player IDs', args: '', category: 'Players' },
    { name: 'makerpen', desc: 'Access maker pen', args: '', category: 'Tools' },
    { name: 'collideplr', desc: 'Toggle player collision', args: '', category: 'Players' },
    { name: 'allbuttons', desc: 'Press all buttons', args: '', category: 'Tools' },
  ];

  res.render('commands', { title: 'Commands - Rec Home', commands });
});

module.exports = router;
