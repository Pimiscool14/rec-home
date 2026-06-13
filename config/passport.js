const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcryptjs');
const db = require('../database/db');

passport.serializeUser((user, done) => {
  done(null, user.id);
});

passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT id, username, email, display_name, avatar_url, discord_id, discord_username, tokens, level, xp, role, is_banned, created_at, last_login FROM users WHERE id = ?').get(id);
    done(null, user || null);
  } catch (err) {
    console.error('Passport deserialize error:', err);
    done(err, null);
  }
});

// Local (Email/Password) Strategy
passport.use(new LocalStrategy(
  { usernameField: 'email', passwordField: 'password' },
  (email, password, done) => {
    try {
      const user = db.prepare('SELECT * FROM users WHERE email = ? OR username = ?').get(email, email);
      
      if (!user) {
        return done(null, false, { message: 'Invalid email or password.' });
      }

      if (!user.password_hash) {
        return done(null, false, { message: 'This account uses Discord login. Please log in with Discord.' });
      }

      if (user.is_banned) {
        return done(null, false, { message: 'This account has been banned.' });
      }

      const validPassword = bcrypt.compareSync(password, user.password_hash);
      if (!validPassword) {
        return done(null, false, { message: 'Invalid email or password.' });
      }

      // Update last login
      db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(user.id);

      // Return user without password hash
      const { password_hash, ...safeUser } = user;
      return done(null, safeUser);
    } catch (err) {
      return done(err);
    }
  }
));

// Discord Strategy
passport.use(new DiscordStrategy(
  {
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: process.env.DISCORD_CALLBACK_URL,
    scope: ['identify', 'email'],
  },
  (accessToken, refreshToken, profile, done) => {
    try {
      const discordId = profile.id;
      const discordUsername = `${profile.username}#${profile.discriminator}`;
      const discordAvatar = profile.avatar
        ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png`
        : null;
      const email = profile.email || `${profile.id}@discord.user`;

      // Find or create user
      let user = db.prepare('SELECT * FROM users WHERE discord_id = ?').get(discordId);

      if (!user) {
        // Check if email already exists
        const emailUser = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
        if (emailUser) {
          // Link Discord to existing account
          db.prepare('UPDATE users SET discord_id = ?, discord_username = ?, discord_avatar = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?')
            .run(discordId, discordUsername, discordAvatar, emailUser.id);
          user = db.prepare('SELECT * FROM users WHERE id = ?').get(emailUser.id);
        } else {
          // Create new user
          const username = profile.username + (profile.discriminator !== '0' ? profile.discriminator : '');
          let uniqueUsername = username;
          let counter = 1;
          while (db.prepare('SELECT id FROM users WHERE username = ?').get(uniqueUsername)) {
            uniqueUsername = `${username}${counter}`;
            counter++;
          }

          const result = db.prepare(
            'INSERT INTO users (username, email, display_name, avatar_url, discord_id, discord_username, discord_avatar) VALUES (?, ?, ?, ?, ?, ?, ?)'
          ).run(uniqueUsername, email, profile.username, profile.avatar 
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` 
            : null,
            discordId,
            discordUsername,
            discordAvatar
          );

          // Create default settings
          db.prepare('INSERT INTO user_settings (user_id) VALUES (?)').run(result.lastInsertRowid);

          user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
        }
      } else {
        // Update Discord info
        db.prepare('UPDATE users SET discord_username = ?, discord_avatar = ?, avatar_url = ?, last_login = CURRENT_TIMESTAMP WHERE id = ?')
          .run(discordUsername, discordAvatar, profile.avatar 
            ? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png` 
            : user.avatar_url,
            user.id
          );
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      }

      if (user.is_banned) {
        return done(null, false, { message: 'This account has been banned.' });
      }

      const { password_hash, ...safeUser } = user;
      return done(null, safeUser);
    } catch (err) {
      return done(err);
    }
  }
));

module.exports = passport;
