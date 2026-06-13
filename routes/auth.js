const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const db = require('../database/db');
const { isAuthenticated, setUserLocals } = require('../middleware/auth');
const { generateToken } = require('../middleware/jwt');
const { body, validationResult } = require('express-validator');

const router = express.Router();

// ==================== API Register ====================
router.post('/api/register', [
  body('username').trim().isLength({ min: 3, max: 24 }).matches(/^[a-zA-Z0-9_]+$/),
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

  const { username, email, password } = req.body;
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) return res.status(400).json({ error: 'Username or email taken.' });

  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, email, bcrypt.hashSync(password, 12), username);

  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);
  const user = db.prepare(
    'SELECT id, username, email, display_name, avatar_url, tokens, level, xp, role FROM users WHERE id = ?'
  ).get(result.lastInsertRowid);

  const token = generateToken(user);
  res.json({ user, token });
});

// ==================== API Login ====================
router.post('/api/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return res.status(500).json({ error: 'Server error.' });
    if (!user) return res.status(401).json({ error: info?.message || 'Invalid credentials.' });
    req.login(user, (err) => {
      if (err) return res.status(500).json({ error: 'Login failed.' });
      const token = generateToken(user);
      res.json({ user, token });
    });
  })(req, res, next);
});

// ==================== Get JWT Token (when already logged in via session) ====================
router.get('/api/token', isAuthenticated, (req, res) => {
  const token = generateToken(req.user);
  res.json({ token });
});

// ==================== Register Page ====================
router.get('/register', setUserLocals, (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('register', { title: 'Sign Up - Rec Home', discordClientId: process.env.DISCORD_CLIENT_ID });
});

// ==================== Register Handler ====================
router.post('/register', [
  body('username').trim().isLength({ min: 3, max: 24 }).withMessage('Username must be 3-24 characters')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('Username can only contain letters, numbers, and underscores'),
  body('email').isEmail().normalizeEmail().withMessage('Please enter a valid email'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
  body('confirm_password').custom((value, { req }) => {
    if (value !== req.body.password) throw new Error('Passwords do not match');
    return true;
  }),
], (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    req.flash('error', errors.array().map(e => e.msg).join('. '));
    return res.redirect('/register');
  }

  const { username, email, password } = req.body;

  // Check if username or email already exists
  const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
  if (existing) {
    req.flash('error', 'Username or email already taken.');
    return res.redirect('/register');
  }

  // Create user
  const passwordHash = bcrypt.hashSync(password, 12);
  const result = db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name) VALUES (?, ?, ?, ?)'
  ).run(username, email, passwordHash, username);

  // Create default settings
  db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);

  // Auto-login
  const user = db.prepare('SELECT id, username, email, display_name, avatar_url, tokens, level, xp, role, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
  
  req.login(user, (err) => {
    if (err) return next(err);
    req.flash('success', 'Welcome to Rec Home!');
    return res.redirect('/dashboard');
  });
});

// ==================== Login Page ====================
router.get('/login', setUserLocals, (req, res) => {
  if (req.isAuthenticated()) return res.redirect('/dashboard');
  res.render('login', { title: 'Login - Rec Home', discordClientId: process.env.DISCORD_CLIENT_ID });
});

// ==================== Login Handler ====================
router.post('/login', (req, res, next) => {
  passport.authenticate('local', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.flash('error', info.message || 'Invalid email or password.');
      return res.redirect('/login');
    }
    req.login(user, (err) => {
      if (err) return next(err);
      req.flash('success', `Welcome back, ${user.display_name || user.username}!`);
      
      // Redirect to intended page or dashboard
      const redirectTo = req.session.returnTo || '/dashboard';
      delete req.session.returnTo;
      return res.redirect(redirectTo);
    });
  })(req, res, next);
});

// ==================== Discord OAuth ====================
router.get('/discord', (req, res, next) => {
  if (!process.env.DISCORD_CLIENT_ID || process.env.DISCORD_CLIENT_ID === 'your-discord-client-id') {
    req.flash('error', 'Discord login is not configured. Please use email/password.');
    return res.redirect('/login');
  }
  passport.authenticate('discord')(req, res, next);
});

router.get('/discord/callback', (req, res, next) => {
  passport.authenticate('discord', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      req.flash('error', info?.message || 'Discord login failed.');
      return res.redirect('/login');
    }
    req.login(user, (err) => {
      if (err) return next(err);
      req.flash('success', `Welcome, ${user.display_name || user.username}!`);
      return res.redirect('/dashboard');
    });
  })(req, res, next);
});

// ==================== Logout ====================
router.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.flash('success', 'You have been logged out.');
    res.redirect('/');
  });
});

// ==================== Profile Page ====================
router.get('/profile', isAuthenticated, setUserLocals, (req, res) => {
  const settings = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
  const recentCommands = db.prepare(
    'SELECT * FROM command_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 20'
  ).all(req.user.id);
  const apiKeys = db.prepare('SELECT * FROM api_keys WHERE user_id = ?').all(req.user.id);

  res.render('profile', {
    title: 'Profile - Rec Home',
    settings: settings || {},
    recentCommands,
    apiKeys,
  });
});

// ==================== Settings Update ====================
router.post('/settings', isAuthenticated, (req, res) => {
  const { esp_color, esp_enabled, fly_enabled, bio, display_name } = req.body;
  
  // Checkboxes: if key exists in body, it's checked (1); if absent, it's unchecked (0)
  const espEnabled = 'esp_enabled' in req.body ? 1 : 0;
  const flyEnabled = 'fly_enabled' in req.body ? 1 : 0;

  db.prepare(`
    UPDATE user_settings 
    SET esp_color = COALESCE(?, esp_color),
        esp_enabled = ?,
        fly_enabled = ?
    WHERE user_id = ?
  `).run(esp_color || null, espEnabled, flyEnabled, req.user.id);

  // Update bio and display name
  if (bio !== undefined) {
    db.prepare('UPDATE users SET bio = ? WHERE id = ?').run(bio, req.user.id);
  }
  if (display_name !== undefined) {
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(display_name, req.user.id);
  }

  req.flash('success', 'Settings updated!');
  res.redirect('/profile');
});

// ==================== Generate API Key ====================
router.post('/api-key/generate', isAuthenticated, (req, res) => {
  const uuid = require('uuid');
  const apiKey = `rh_${uuid.v4().replace(/-/g, '')}`;

  db.prepare('INSERT INTO api_keys (user_id, api_key, name) VALUES (?, ?, ?)')
    .run(req.user.id, apiKey, req.body.name || 'Default');

  req.flash('success', 'New API key generated!');
  res.redirect('/profile');
});

// ==================== Delete API Key ====================
router.post('/api-key/delete/:id', isAuthenticated, (req, res) => {
  db.prepare('DELETE FROM api_keys WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  req.flash('success', 'API key deleted.');
  res.redirect('/profile');
});

module.exports = router;
