const jwt = require('jsonwebtoken');
const db = require('../database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'rec-home-jwt-secret';
const TOKEN_EXPIRY = '7d';

// Generate JWT token for a user
function generateToken(user) {
  return jwt.sign(
    { userId: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// Middleware: verify JWT from Authorization header
function jwtAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token;

  let token = null;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.slice(7);
  } else if (authHeader && authHeader.startsWith('rh_')) {
    // API key fallback
    return apiKeyFallback(authHeader, req, res, next);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token) {
    // Try API key from x-api-key header
    const apiKey = req.headers['x-api-key'];
    if (apiKey) return apiKeyFallback(apiKey, req, res, next);
    if (req.isAuthenticated()) return next(); // Session fallback
    return res.status(401).json({ error: 'JWT token or API key required.' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = db.prepare(
      'SELECT id, username, email, display_name, avatar_url, tokens, level, xp, role, is_banned FROM users WHERE id = ?'
    ).get(decoded.userId);

    if (!user) return res.status(401).json({ error: 'User not found.' });
    if (user.is_banned) return res.status(403).json({ error: 'Account banned.' });

    req.user = user;
    req.authType = 'jwt';
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }
}

function apiKeyFallback(key, req, res, next) {
  const keyRecord = db.prepare('SELECT * FROM api_keys WHERE api_key = ?').get(key);
  if (!keyRecord) return res.status(401).json({ error: 'Invalid credentials.' });

  const user = db.prepare(
    'SELECT id, username, email, display_name, avatar_url, tokens, level, xp, role, is_banned FROM users WHERE id = ?'
  ).get(keyRecord.user_id);

  if (!user) return res.status(401).json({ error: 'User not found.' });
  if (user.is_banned) return res.status(403).json({ error: 'Account banned.' });

  req.user = user;
  req.authType = 'apikey';
  next();
}

// Optional auth (doesn't fail if no token, just sets req.user)
function optionalJwtAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(authHeader.slice(7), JWT_SECRET);
      req.user = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(decoded.userId);
    } catch (e) {}
  }
  next();
}

module.exports = { generateToken, jwtAuth, optionalJwtAuth };
