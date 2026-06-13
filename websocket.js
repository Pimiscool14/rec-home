const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const db = require('./database/db');

const JWT_SECRET = process.env.JWT_SECRET || 'rec-home-jwt-secret';

const clients = new Map(); // userId -> { ws, username, rooms: Set, lastPing }
const onlineUsers = new Set();

function setupWebSocket(httpServer, httpsServer) {
  // Attach to both HTTP and HTTPS servers with shared connection handler
  function handleConnection(ws, req) {
    let userId = null;
    let username = null;

    // Auth via token in query string
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.userId;
        username = decoded.username;
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
        ws.close();
        return;
      }
    }

    if (!userId) {
      ws.send(JSON.stringify({ type: 'error', message: 'Authentication required. Pass ?token=JWT' }));
      ws.close();
      return;
    }

    // Register client
    clients.set(userId, { ws, username, rooms: new Set(), lastPing: Date.now() });
    onlineUsers.add(userId);

    // Broadcast online status
    broadcast({ type: 'presence', userId, username, online: true });

    // Send initial data
    const unreadNotifications = db.prepare(
      'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND is_read = 0'
    ).get(userId).count;

    const unreadMessages = db.prepare(
      'SELECT COUNT(*) as count FROM messages WHERE recipient_id = ? AND is_read = 0'
    ).get(userId).count;

    ws.send(JSON.stringify({
      type: 'connected',
      userId,
      unreadNotifications,
      unreadMessages,
      onlineCount: onlineUsers.size,
    }));

    // Handle messages
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleMessage(userId, username, msg, ws);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
      }
    });

    // Ping/pong for presence
    ws.on('pong', () => {
      const client = clients.get(userId);
      if (client) client.lastPing = Date.now();
    });

    // Handle disconnect
    ws.on('close', () => {
      clients.delete(userId);
      onlineUsers.delete(userId);
      broadcast({ type: 'presence', userId, username, online: false });
    });
  }

  const wssHttp = new WebSocket.Server({ server: httpServer, path: '/ws' });
  wssHttp.on('connection', handleConnection);

  if (httpsServer) {
    const wssHttps = new WebSocket.Server({ server: httpsServer, path: '/ws' });
    wssHttps.on('connection', handleConnection);
  }

  // Ping all clients every 30 seconds
  setInterval(() => {
    const now = Date.now();
    clients.forEach((client, uid) => {
      if (now - client.lastPing > 90000) {
        client.ws.terminate();
        clients.delete(uid);
        onlineUsers.delete(uid);
      } else {
        client.ws.ping();
      }
    });
  }, 30000);

  console.log('  [WS]    WebSocket server ready on /ws');
}

function handleMessage(userId, username, msg, ws) {
  const client = clients.get(userId);

  switch (msg.type) {
    // === Chat ===
    case 'chat_message':
      handleChatMessage(userId, username, msg, client);
      break;

    case 'chat_history':
      handleChatHistory(userId, msg, ws);
      break;

    case 'mark_read':
      handleMarkRead(userId, msg, ws);
      break;

    // === Rooms ===
    case 'join_room':
      if (client && msg.roomId) {
        client.rooms.add(msg.roomId);
        ws.send(JSON.stringify({ type: 'joined_room', roomId: msg.roomId }));
      }
      break;

    case 'leave_room':
      if (client && msg.roomId) {
        client.rooms.delete(msg.roomId);
        ws.send(JSON.stringify({ type: 'left_room', roomId: msg.roomId }));
      }
      break;

    // === Presence ===
    case 'get_online':
      ws.send(JSON.stringify({
        type: 'online_list',
        online: Array.from(onlineUsers),
        count: onlineUsers.size,
      }));
      break;

    // === Party ===
    case 'party_invite':
      handlePartyInvite(userId, username, msg);
      break;

    case 'party_accept':
    case 'party_decline':
      handlePartyResponse(userId, username, msg);
      break;

    default:
      ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${msg.type}` }));
  }
}

// === Chat Handlers ===

function handleChatMessage(userId, username, msg, client) {
  const { content, roomId, recipientId, partyId } = msg;
  if (!content || !content.trim()) return;

  // Check if muted
  const mute = db.prepare(
    'SELECT * FROM mutes WHERE user_id = ? AND (expires_at IS NULL OR expires_at > datetime(\"now\"))'
  ).get(userId);
  if (mute) {
    client.ws.send(JSON.stringify({ type: 'error', message: 'You are muted.' }));
    return;
  }

  // Store message
  const result = db.prepare(`
    INSERT INTO messages (sender_id, recipient_id, room_id, party_id, content)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, recipientId || null, roomId || null, partyId || null, content.trim());

  const message = {
    id: result.lastInsertRowid,
    senderId: userId,
    senderName: username,
    content: content.trim(),
    roomId: roomId || null,
    recipientId: recipientId || null,
    partyId: partyId || null,
    createdAt: new Date().toISOString(),
  };

  if (roomId) {
    // Broadcast to all clients in the room
    clients.forEach((c, uid) => {
      if (c.rooms.has(roomId) && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: 'room_message', ...message }));
      }
    });
  } else if (recipientId) {
    // Private message
    const recipient = clients.get(recipientId);
    if (recipient && recipient.ws.readyState === WebSocket.OPEN) {
      recipient.ws.send(JSON.stringify({ type: 'private_message', ...message }));
    }
    // Also send back to sender
    client.ws.send(JSON.stringify({ type: 'private_message', ...message }));
  } else if (partyId) {
    // Party chat - broadcast to all party members
    const partyMembers = db.prepare('SELECT user_id FROM party_members WHERE party_id = ?').all(partyId);
    partyMembers.forEach(m => {
      const c = clients.get(m.user_id);
      if (c && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ type: 'party_message', ...message }));
      }
    });
  }
}

function handleChatHistory(userId, msg, ws) {
  const { roomId, recipientId, limit = 50, before } = msg;
  let messages;

  if (roomId) {
    messages = db.prepare(`
      SELECT m.*, u.username as sender_name FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.room_id = ? ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(roomId, ...(before ? [before, limit] : [limit]));
  } else if (recipientId) {
    messages = db.prepare(`
      SELECT m.*, u.username as sender_name FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?))
        AND m.room_id IS NULL
        ${before ? 'AND m.id < ?' : ''}
      ORDER BY m.created_at DESC LIMIT ?
    `).all(userId, recipientId, recipientId, userId, ...(before ? [before, limit] : [limit]));
  } else {
    messages = [];
  }

  ws.send(JSON.stringify({ type: 'chat_history', messages: messages.reverse() }));
}

function handleMarkRead(userId, msg, ws) {
  const { senderId } = msg;
  if (senderId) {
    db.prepare(
      'UPDATE messages SET is_read = 1 WHERE recipient_id = ? AND sender_id = ? AND is_read = 0'
    ).run(userId, senderId);
  }
  ws.send(JSON.stringify({ type: 'marked_read', senderId }));
}

// === Party Handlers ===

function handlePartyInvite(userId, username, msg) {
  const { targetUserId } = msg;
  const target = clients.get(targetUserId);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      type: 'party_invite',
      fromUserId: userId,
      fromUsername: username,
    }));
  }
}

function handlePartyResponse(userId, username, msg) {
  const { targetUserId, accepted } = msg;
  const target = clients.get(targetUserId);
  if (target && target.ws.readyState === WebSocket.OPEN) {
    target.ws.send(JSON.stringify({
      type: accepted ? 'party_accepted' : 'party_declined',
      fromUserId: userId,
      fromUsername: username,
    }));
  }
}

// === Broadcast Helper ===

function broadcast(data) {
  const json = JSON.stringify(data);
  clients.forEach((client) => {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(json);
    }
  });
}

function sendToUser(userId, data) {
  const client = clients.get(userId);
  if (client && client.ws.readyState === WebSocket.OPEN) {
    client.ws.send(JSON.stringify(data));
  }
}

module.exports = { setupWebSocket, sendToUser, broadcast, clients, onlineUsers };
