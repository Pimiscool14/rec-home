require('dotenv').config();
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const passport = require('./config/passport');
const flash = require('connect-flash');
const path = require('path');

const authRoutes = require('./routes/auth');
const apiRoutes = require('./routes/api');
const pageRoutes = require('./routes/pages');
const photoRoutes = require('./routes/photos');
const friendRoutes = require('./routes/friends');
const roomRoutes = require('./routes/rooms');
const inviteRoutes = require('./routes/invites');
const { router: socialRoutes } = require('./routes/social');
const economyRoutes = require('./routes/economy');
const gameRoutes = require('./routes/game');
const moderationRoutes = require('./routes/moderation');
const partyRoutes = require('./routes/parties');
const { setupWebSocket } = require('./websocket');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== View Engine ====================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ==================== Middleware ====================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Session store
app.use(session({
  store: new SQLiteStore({ dir: path.join(__dirname, 'database'), db: 'sessions.db' }),
  secret: process.env.SESSION_SECRET || (console.warn('WARNING: Using default session secret. Set SESSION_SECRET in .env for production!'), 'rec-home-secret'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
  },
}));

// Flash messages
app.use(flash());

// Passport
app.use(passport.initialize());
app.use(passport.session());

// ==================== Routes ====================
app.use('/', pageRoutes);
app.use('/auth', authRoutes);
app.use('/api', apiRoutes);
app.use('/api/social', socialRoutes);
app.use('/api/economy', economyRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/moderation', moderationRoutes);
app.use('/api/parties', partyRoutes);
app.use('/photos', photoRoutes);
app.use('/friends', friendRoutes);
app.use('/rooms', roomRoutes);
app.use('/invites', inviteRoutes);

// ==================== 404 Handler ====================
app.use((req, res) => {
  res.status(404).render('404', { title: '404 - Not Found' });
});

// ==================== Error Handler ====================
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  res.status(500).render('500', { title: '500 - Server Error', error: process.env.NODE_ENV === 'development' ? err.message : null });
});

// ==================== Start Servers ====================

// Create HTTP server (used by both HTTP and WebSocket)
const httpServer = http.createServer(app);

// Attach WebSocket to HTTP server immediately
setupWebSocket(httpServer, null);

// HTTPS server will be set below for dual WS support
let httpsServer = null;

// Start HTTP
httpServer.listen(PORT, () => {
  console.log(`  [HTTP]  http://localhost:${PORT}`);
});

// HTTPS server (port 443) - for the game to connect via rec.net redirect
const certPath = path.join(__dirname, 'certs', 'cert.pem');
const keyPath = path.join(__dirname, 'certs', 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  const sslOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };

  try {
    httpsServer = https.createServer(sslOptions, app);
    httpsServer.listen(443, () => {
      console.log(`  [HTTPS] https://localhost:443`);
      console.log(`  [HTTPS] Game redirect active - rec.net -> localhost`);
    }).on('error', (err) => {
      if (err.code === 'EACCES') {
        console.log(`  [WARN]  Port 443 requires Admin. Run as Administrator!`);
        httpsServer = https.createServer(sslOptions, app);
        httpsServer.listen(8443, () => {
          console.log(`  [HTTPS] Fallback: https://localhost:8443`);
        });
      } else {
        console.error(`  [ERROR] HTTPS failed:`, err.message);
      }
    });
  } catch (e) {
    console.error(`  [ERROR] HTTPS setup failed:`, e.message);
  }
} else {
  console.log(`  [WARN]  SSL certs not found. Run Setup Rec Home.bat first.`);
}

console.log(`
╔══════════════════════════════════════════╗
║         🏠  REC HOME SERVER  🏠          ║
║                                          ║
║  Dashboard:  http://localhost:${PORT}        ║
║  API:        http://localhost:${PORT}/api     ║
║  Game (SSL): https://localhost:443        ║
║                                          ║
╚══════════════════════════════════════════╝
`);
