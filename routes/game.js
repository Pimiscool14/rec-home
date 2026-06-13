const express = require('express');
const db = require('../database/db');
const { isAuthenticated } = require('../middleware/auth');

const router = express.Router();

// ==================== LEADERBOARDS ====================

router.get('/leaderboards/:board', (req, res) => {
  const { board } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = 20;

  const entries = db.prepare(`
    SELECT le.*, u.username, u.display_name, u.avatar_url, u.level
    FROM leaderboard_entries le
    JOIN users u ON le.user_id = u.id
    WHERE le.board_name = ?
    ORDER BY le.score DESC
    LIMIT ? OFFSET ?
  `).all(board, limit, (page - 1) * limit);

  const total = db.prepare('SELECT COUNT(*) as count FROM leaderboard_entries WHERE board_name = ?').get(board).count;

  // Add rank
  const ranked = entries.map((e, i) => ({ ...e, rank: (page - 1) * limit + i + 1 }));

  res.json({ board, entries: ranked, page, totalPages: Math.ceil(total / limit) });
});

router.post('/leaderboards/submit', isAuthenticated, (req, res) => {
  const { board, score, room_id } = req.body;
  if (!board || score === undefined) return res.status(400).json({ error: 'Board name and score required.' });

  // Insert or update (keep best score)
  const existing = db.prepare(
    'SELECT * FROM leaderboard_entries WHERE user_id = ? AND board_name = ? AND month = ?'
  ).get(req.user.id, board, new Date().toISOString().slice(0, 7));

  if (existing) {
    if (score > existing.score) {
      db.prepare('UPDATE leaderboard_entries SET score = ?, room_id = ? WHERE id = ?')
        .run(score, room_id || null, existing.id);
    }
  } else {
    db.prepare(
      'INSERT INTO leaderboard_entries (user_id, board_name, score, room_id, month) VALUES (?, ?, ?, ?, ?)'
    ).run(req.user.id, board, score, room_id || null, new Date().toISOString().slice(0, 7));
  }

  res.json({ success: true, board, score });
});

// ==================== PLAYER STATS ====================

router.get('/stats', isAuthenticated, (req, res) => {
  const userId = parseInt(req.query.userId) || req.user.id;

  let stats = db.prepare('SELECT * FROM player_stats WHERE user_id = ?').get(userId);
  if (!stats) {
    db.prepare('INSERT INTO player_stats (user_id) VALUES (?)').run(userId);
    stats = db.prepare('SELECT * FROM player_stats WHERE user_id = ?').get(userId);
  }

  res.json({ stats });
});

router.post('/stats/update', isAuthenticated, (req, res) => {
  const { games_played, games_won, total_score, kills, deaths, playtime_minutes, rooms_visited, stats_json } = req.body;

  // Ensure stats row exists
  const existing = db.prepare('SELECT * FROM player_stats WHERE user_id = ?').get(req.user.id);
  if (!existing) {
    db.prepare('INSERT INTO player_stats (user_id) VALUES (?)').run(req.user.id);
  }

  const updates = [];
  const params = [];

  if (games_played !== undefined) { updates.push('games_played = games_played + ?'); params.push(games_played); }
  if (games_won !== undefined) { updates.push('games_won = games_won + ?'); params.push(games_won); }
  if (total_score !== undefined) { updates.push('total_score = total_score + ?'); params.push(total_score); }
  if (kills !== undefined) { updates.push('kills = kills + ?'); params.push(kills); }
  if (deaths !== undefined) { updates.push('deaths = deaths + ?'); params.push(deaths); }
  if (playtime_minutes !== undefined) { updates.push('playtime_minutes = playtime_minutes + ?'); params.push(playtime_minutes); }
  if (rooms_visited !== undefined) { updates.push('rooms_visited = rooms_visited + ?'); params.push(rooms_visited); }
  if (stats_json) { updates.push('stats_json = ?'); params.push(JSON.stringify(stats_json)); }

  if (updates.length > 0) {
    params.push(req.user.id);
    db.prepare(`UPDATE player_stats SET ${updates.join(', ')} WHERE user_id = ?`).run(...params);
  }

  res.json({ success: true });
});

// ==================== ACHIEVEMENTS ====================

router.get('/achievements', (req, res) => {
  const achievements = db.prepare('SELECT * FROM achievements').all();
  res.json({ achievements });
});

router.get('/achievements/my', isAuthenticated, (req, res) => {
  const achievements = db.prepare(`
    SELECT a.*, ua.progress, ua.completed, ua.completed_at
    FROM achievements a
    LEFT JOIN user_achievements ua ON a.id = ua.achievement_id AND ua.user_id = ?
    ORDER BY a.id
  `).all(req.user.id);
  res.json({ achievements });
});

router.post('/achievements/progress', isAuthenticated, (req, res) => {
  const { achievementId, progress } = req.body;

  const achievement = db.prepare('SELECT * FROM achievements WHERE id = ?').get(achievementId);
  if (!achievement) return res.status(404).json({ error: 'Achievement not found.' });

  const existing = db.prepare(
    'SELECT * FROM user_achievements WHERE user_id = ? AND achievement_id = ?'
  ).get(req.user.id, achievementId);

  if (existing && existing.completed) {
    return res.json({ success: true, message: 'Already completed.', completed: true });
  }

  if (existing) {
    db.prepare('UPDATE user_achievements SET progress = ? WHERE id = ?').run(progress, existing.id);
  } else {
    db.prepare(
      'INSERT INTO user_achievements (user_id, achievement_id, progress) VALUES (?, ?, ?)'
    ).run(req.user.id, achievementId, progress);
  }

  // Check if completed
  if (progress >= 100) {
    db.prepare(
      'UPDATE user_achievements SET completed = 1, completed_at = CURRENT_TIMESTAMP, progress = 100 WHERE user_id = ? AND achievement_id = ?'
    ).run(req.user.id, achievementId);

    // Grant rewards
    if (achievement.xp_reward) {
      db.prepare('UPDATE users SET xp = xp + ? WHERE id = ?').run(achievement.xp_reward, req.user.id);
    }
    if (achievement.token_reward) {
      db.prepare('UPDATE users SET tokens = tokens + ? WHERE id = ?').run(achievement.token_reward, req.user.id);
      db.prepare('INSERT INTO currency_transactions (user_id, amount, currency_type, reason) VALUES (?, ?, ?, ?)')
        .run(req.user.id, achievement.token_reward, 'tokens', `Achievement: ${achievement.name}`);
    }

    return res.json({ success: true, message: `Achievement unlocked: ${achievement.name}!`, completed: true, rewards: { xp: achievement.xp_reward, tokens: achievement.token_reward } });
  }

  res.json({ success: true, progress });
});

// ==================== PLAYER DATA (Save/Load) ====================

router.get('/playerdata', isAuthenticated, (req, res) => {
  const settings = db.prepare('SELECT settings_json FROM user_settings WHERE user_id = ?').get(req.user.id);
  const stats = db.prepare('SELECT * FROM player_stats WHERE user_id = ?').get(req.user.id) || {};
  const inventory = db.prepare(`
    SELECT i.*, s.name, s.category FROM inventory_items i JOIN store_items s ON i.item_id = s.id WHERE i.user_id = ?
  `).all(req.user.id);

  res.json({
    settings: settings ? JSON.parse(settings.settings_json || '{}') : {},
    stats,
    inventory,
  });
});

router.post('/playerdata/save', isAuthenticated, (req, res) => {
  const { settings, progress } = req.body;

  if (settings) {
    const existing = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(req.user.id);
    if (existing) {
      db.prepare('UPDATE user_settings SET settings_json = ? WHERE user_id = ?')
        .run(JSON.stringify(settings), req.user.id);
    } else {
      db.prepare('INSERT INTO user_settings (user_id, settings_json) VALUES (?, ?)')
        .run(req.user.id, JSON.stringify(settings));
    }
  }

  res.json({ success: true, message: 'Player data saved.' });
});

module.exports = router;
