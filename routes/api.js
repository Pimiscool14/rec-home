const express = require('express');
const crypto = require('crypto');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== API Key Authentication ====================
function apiKeyAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const apiKey = req.headers['x-api-key'] || req.query.api_key;

  // Check Authorization header (Bearer token OR raw API key)
  let token = apiKey;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (authHeader && authHeader.startsWith('rh_')) {
    token = authHeader;
  }

  if (!token) {
    // Try session auth as fallback
    if (req.isAuthenticated()) {
      return next();
    }
    return res.status(401).json({ error: 'API key required. Provide via x-api-key header or Bearer token.' });
  }

  const keyRecord = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(token);
  if (!keyRecord) {
    return res.status(401).json({ error: 'Invalid API key.' });
  }

  // Get user
  const user = db.prepare('SELECT id, username, email, display_name, avatar_url, tokens, level, xp, role FROM users WHERE id = ?').get(keyRecord.user_id);
  if (!user) {
    return res.status(401).json({ error: 'User not found.' });
  }

  if (user.is_banned) {
    return res.status(403).json({ error: 'Account is banned.' });
  }

  // Update last used
  db.prepare('UPDATE api_keys SET last_used = CURRENT_TIMESTAMP WHERE id = ?').run(keyRecord.id);

  req.user = user;
  req.apiKey = keyRecord;
  next();
}

// ==================== Status ====================
router.get('/status', (req, res) => {
  res.json({
    status: 'online',
    name: 'Rec Home API',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    authenticated: req.isAuthenticated() || false,
  });
});

// ==================== User Info (API Key or Session) ====================
router.get('/user', apiKeyAuth, (req, res) => {
  const user = req.user;
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(user.id);
  
  res.json({
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    tokens: user.tokens,
    level: user.level,
    xp: user.xp,
    role: user.role,
    settings: settings ? {
      esp_color: settings.esp_color,
      esp_enabled: settings.esp_enabled,
      fly_enabled: settings.fly_enabled,
    } : null,
  });
});

// ==================== Sync Settings (API Key or Session) ====================
router.post('/sync', apiKeyAuth, (req, res) => {
  const { settings, command } = req.body;
  const userId = req.user.id;

  // Update settings if provided
  if (settings) {
    const current = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId);
    
    if (current) {
      db.prepare(`
        UPDATE user_settings 
        SET settings_json = ?
        WHERE user_id = ?
      `).run(typeof settings === 'string' ? settings : JSON.stringify(settings), userId);
    } else {
      db.prepare('INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)')
        .run(userId, typeof settings === 'string' ? settings : JSON.stringify(settings));
    }
  }

  // Log command if provided
  if (command) {
    db.prepare('INSERT INTO command_logs (user_id, command, args, room_name) VALUES (?, ?, ?, ?)')
      .run(userId, command.name || command, command.args ? JSON.stringify(command.args) : null, command.room || null);
  }

  res.json({ success: true, message: 'Synced successfully' });
});

// ==================== Command Log ====================
router.post('/command-log', apiKeyAuth, (req, res) => {
  const { command, args, room } = req.body;

  if (!command) {
    return res.status(400).json({ error: 'Command name required.' });
  }

  db.prepare('INSERT INTO command_logs (user_id, command, args, room_name) VALUES (?, ?, ?, ?)')
    .run(req.user.id, command, args ? JSON.stringify(args) : null, room || null);

  res.json({ success: true });
});

// ==================== Verify Token ====================
router.get('/verify', apiKeyAuth, (req, res) => {
  res.json({
    valid: true,
    user_id: req.user.id,
    username: req.user.username,
    role: req.user.role,
    expires: null, // API keys don't expire
  });
});

// ==================== Check for Updates ====================
router.get('/updates', apiKeyAuth, (req, res) => {
  res.json({
    latest_version: '1.0.0',
    download_url: null,
    changelog: 'Initial Rec Home release.',
    force_update: false,
  });
});

module.exports = router;
