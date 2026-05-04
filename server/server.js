/**
 * iText Chat — Server
 * Node.js + ws  |  node server/server.js
 *
 * Features (merged from itext + itext_pro):
 *  - 100 user hard cap per room (warns at 90)
 *  - Image / file sharing (base64, up to 10 MB)
 *  - Emoji reactions
 *  - Reply-to messages
 *  - Read receipts
 *  - Typing indicators with debounce
 *  - Rate limiting (burst + sustained)
 *  - Room metadata + /api/rooms endpoint
 *  - Auto-reconnect ping/pong
 *  - Room capacity broadcast
 *  - Extended MIME types for file serving
 */

"use strict";

const { WebSocketServer, WebSocket } = require("ws");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const PORT              = process.env.PORT || 3000;
const MAX_ROOM_MEMBERS  = 100;
const WARN_ROOM_MEMBERS = 90;
const MAX_USERNAME_LEN  = 20;
const MAX_MESSAGE_LEN   = 2000;
const MAX_FILE_SIZE     = 10 * 1024 * 1024; // 10 MB
const RATE_MAX          = 15;
const RATE_WINDOW_MS    = 5_000;
const TYPING_CLEAR_MS   = 3_500;

// ─── STORES ────────────────────────────────────────────────────────────────

const rooms      = {};   // roomName → { users, sockets, createdAt, messageCount }
const clientMeta = {};   // socketId → { room, username, rateWindow[], typingTimer, ip }
let   nextId     = 1;
const genId      = () => `s${nextId++}`;

// ─── HTTP SERVER ───────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg":  "image/svg+xml",
  ".ico":  "image/x-icon",
  ".webp": "image/webp",
  ".gif":  "image/gif",
};

const httpServer = http.createServer((req, res) => {
  // ── Public room-list API ──
  if (req.url === "/api/rooms") {
    const list = Object.entries(rooms).map(([name, r]) => ({
      name,
      count:        Object.keys(r.users).length,
      max:          MAX_ROOM_MEMBERS,
      createdAt:    r.createdAt,
      messageCount: r.messageCount,
    }));
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(JSON.stringify({ rooms: list, serverTime: Date.now() }));
    return;
  }

  // ── Static file serving ──
  const safePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, "../client", safePath);
  const ext      = path.extname(filePath).toLowerCase();

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type":  MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  });
});

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, perMessageDeflate: true });

wss.on("connection", (ws, req) => {
  const socketId = genId();
  clientMeta[socketId] = {
    room:        null,
    username:    null,
    rateWindow:  [],
    typingTimer: null,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress,
  };

  console.log(`[+] ${socketId} connected`);

  sendTo(ws, {
    type:    "welcome",
    socketId,
    maxRoom: MAX_ROOM_MEMBERS,
    maxMsg:  MAX_MESSAGE_LEN,
  });

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return; // all data is JSON text
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case "join_room":    handleJoin(socketId, ws, data);      break;
      case "send_message": handleMessage(socketId, ws, data);   break;
      case "send_media":   handleMedia(socketId, ws, data);     break;
      case "typing":       handleTyping(socketId, data);         break;
      case "nick":         handleNick(socketId, ws, data);       break;
      case "reaction":     handleReaction(socketId, ws, data);   break;
      case "read":         handleRead(socketId, data);            break;
      case "ping":         sendTo(ws, { type: "pong", t: data.t }); break;
    }
  });

  ws.on("close", ()  => handleDisconnect(socketId));
  ws.on("error", (e) => {
    console.error(`[!] ${socketId}:`, e.message);
    handleDisconnect(socketId);
  });
});

// ─── JOIN ──────────────────────────────────────────────────────────────────

function handleJoin(socketId, ws, data) {
  const meta     = clientMeta[socketId];
  const roomName = cleanRoom(data.room);
  const username = cleanUsername(data.username);

  if (!roomName || !username) {
    sendTo(ws, { type: "error", code: "INVALID_INPUT", text: "Invalid room or username." });
    return;
  }

  // Create room lazily
  if (!rooms[roomName]) {
    rooms[roomName] = { users: {}, sockets: {}, createdAt: Date.now(), messageCount: 0 };
  }

  const room      = rooms[roomName];
  const isRejoin  = meta.room === roomName;
  const roomCount = Object.keys(room.users).length;

  if (!isRejoin && roomCount >= MAX_ROOM_MEMBERS) {
    sendTo(ws, {
      type: "error", code: "ROOM_FULL",
      text: `Room is full! Max ${MAX_ROOM_MEMBERS} people per room.`,
    });
    return;
  }

  if (meta.room && meta.room !== roomName) leaveRoom(socketId);

  room.users[socketId]   = username;
  room.sockets[socketId] = ws;
  meta.room     = roomName;
  meta.username = username;

  const newCount = Object.keys(room.users).length;
  console.log(`[>] ${username}(${socketId}) → #${roomName}  (${newCount}/${MAX_ROOM_MEMBERS})`);

  sendTo(ws, {
    type:         "joined",
    room:         roomName,
    username,
    users:        Object.values(room.users),
    count:        newCount,
    max:          MAX_ROOM_MEMBERS,
    createdAt:    room.createdAt,
    messageCount: room.messageCount,
  });

  broadcast(roomName, {
    type:      "system",
    text:      `${username} joined`,
    count:     newCount,
    max:       MAX_ROOM_MEMBERS,
    timestamp: Date.now(),
  }, socketId);

  if (newCount === WARN_ROOM_MEMBERS) {
    broadcastAll(roomName, {
      type:      "system",
      text:      `⚠️ Room is almost full (${newCount}/${MAX_ROOM_MEMBERS}). Only ${MAX_ROOM_MEMBERS - newCount} spots left!`,
      timestamp: Date.now(),
      warning:   true,
    });
  }

  broadcastUserList(roomName);
}

// ─── TEXT MESSAGE ──────────────────────────────────────────────────────────

function handleMessage(socketId, ws, data) {
  const meta = clientMeta[socketId];
  if (!meta.room) return;
  if (!checkRate(socketId, ws)) return;

  const text = cleanText(data.text);
  if (!text) return;

  const msgId = `${socketId}-${Date.now()}`;
  rooms[meta.room].messageCount++;

  broadcastAll(meta.room, {
    type:      "message",
    msgId,
    socketId,
    username:  meta.username,
    text,
    replyTo:   data.replyTo || null,
    timestamp: Date.now(),
  });

  stopTyping(socketId);
}

// ─── MEDIA MESSAGE ─────────────────────────────────────────────────────────

function handleMedia(socketId, ws, data) {
  const meta = clientMeta[socketId];
  if (!meta.room) return;
  if (!checkRate(socketId, ws)) return;

  const { mediaType, fileName, mimeType, data: b64, caption } = data;

  const allowed = [
    "image/jpeg","image/png","image/gif","image/webp","image/svg+xml",
    "application/pdf",
    "text/plain","text/csv",
    "application/zip","application/x-zip-compressed",
    "video/mp4","video/webm",
    "audio/mpeg","audio/ogg","audio/wav",
    "audio/mp4","audio/aac","audio/webm","audio/x-m4a","audio/flac",
    "audio/ogg; codecs=opus","audio/ogg;codecs=opus",
  ];

  if (!allowed.includes(mimeType)) {
    sendTo(ws, { type: "error", code: "UNSUPPORTED_MEDIA", text: `File type not supported: ${mimeType}` });
    return;
  }

  if (!b64 || b64.length > MAX_FILE_SIZE * 1.4) {
    sendTo(ws, {
      type: "error", code: "FILE_TOO_LARGE",
      text: `File too large. Max ${MAX_FILE_SIZE / 1024 / 1024} MB.`,
    });
    return;
  }

  const msgId = `${socketId}-${Date.now()}`;
  rooms[meta.room].messageCount++;

  broadcastAll(meta.room, {
    type:      "media",
    msgId,
    socketId,
    username:  meta.username,
    mediaType,
    fileName:  fileName ? fileName.slice(0, 100) : "file",
    mimeType,
    data:      b64,
    size:      Math.round(b64.length * 0.75),
    caption:   caption ? cleanText(caption) : null,
    timestamp: Date.now(),
  });
}

// ─── TYPING ────────────────────────────────────────────────────────────────

function handleTyping(socketId, data) {
  const meta = clientMeta[socketId];
  if (!meta.room) return;

  if (data.isTyping) {
    broadcast(meta.room, { type: "typing", username: meta.username, isTyping: true }, socketId);
    clearTimeout(meta.typingTimer);
    meta.typingTimer = setTimeout(() => stopTyping(socketId), TYPING_CLEAR_MS);
  } else {
    stopTyping(socketId);
  }
}

// ─── NICK ──────────────────────────────────────────────────────────────────

function handleNick(socketId, ws, data) {
  const meta    = clientMeta[socketId];
  if (!meta.room) return;

  const newName = cleanUsername(data.username);
  if (!newName) {
    sendTo(ws, { type: "error", code: "INVALID_INPUT", text: "Invalid name." });
    return;
  }

  const oldName = meta.username;
  meta.username = newName;
  rooms[meta.room].users[socketId] = newName;

  sendTo(ws, { type: "nick_ok", username: newName });
  broadcastAll(meta.room, {
    type:      "system",
    text:      `${oldName} → ${newName}`,
    timestamp: Date.now(),
  });
  broadcastUserList(meta.room);
}

// ─── REACTION ──────────────────────────────────────────────────────────────

function handleReaction(socketId, ws, data) {
  const meta = clientMeta[socketId];
  if (!meta.room || !data.msgId || !data.emoji) return;

  const allowed = ["👍","❤️","😂","😮","😢","🔥","👏","🎉","💯","😎"];
  if (!allowed.includes(data.emoji)) return;

  broadcastAll(meta.room, {
    type:      "reaction",
    msgId:     data.msgId,
    emoji:     data.emoji,
    username:  meta.username,
    socketId,
    timestamp: Date.now(),
  });
}

// ─── READ RECEIPT ──────────────────────────────────────────────────────────

function handleRead(socketId, data) {
  const meta = clientMeta[socketId];
  if (!meta.room || !data.msgId) return;

  broadcast(meta.room, {
    type:     "read",
    msgId:    data.msgId,
    username: meta.username,
    socketId,
  }, socketId);
}

// ─── DISCONNECT ────────────────────────────────────────────────────────────

function handleDisconnect(socketId) {
  const meta = clientMeta[socketId];
  if (!meta) return;
  console.log(`[-] ${meta.username || "?"}(${socketId}) disconnected`);
  leaveRoom(socketId);
  delete clientMeta[socketId];
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

function checkRate(socketId, ws) {
  const meta = clientMeta[socketId];
  const now  = Date.now();
  meta.rateWindow = meta.rateWindow.filter(t => now - t < RATE_WINDOW_MS);
  if (meta.rateWindow.length >= RATE_MAX) {
    sendTo(ws, { type: "error", code: "RATE_LIMIT", text: "Slow down! You're sending too fast." });
    return false;
  }
  meta.rateWindow.push(now);
  return true;
}

function leaveRoom(socketId) {
  const meta = clientMeta[socketId];
  if (!meta?.room) return;

  const roomName = meta.room;
  const room     = rooms[roomName];
  if (!room) return;

  const username = meta.username;
  delete room.users[socketId];
  delete room.sockets[socketId];
  meta.room = null;

  const remaining = Object.keys(room.users).length;
  if (remaining === 0) { delete rooms[roomName]; return; }

  broadcastAll(roomName, {
    type:      "system",
    text:      `${username} left`,
    count:     remaining,
    max:       MAX_ROOM_MEMBERS,
    timestamp: Date.now(),
  });
  broadcastUserList(roomName);
  stopTyping(socketId);
}

function stopTyping(socketId) {
  const meta = clientMeta[socketId];
  if (!meta?.room) return;
  clearTimeout(meta.typingTimer);
  meta.typingTimer = null;
  broadcast(meta.room, { type: "typing", username: meta.username, isTyping: false }, socketId);
}

function sendTo(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(roomName, data, excludeId = null) {
  const room = rooms[roomName];
  if (!room) return;
  const payload = JSON.stringify(data);
  for (const [sid, ws] of Object.entries(room.sockets)) {
    if (sid !== excludeId && ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastAll(roomName, data) {
  broadcast(roomName, data, null);
}

function broadcastUserList(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  const payload = JSON.stringify({
    type:  "user_list",
    users: Object.values(room.users),
    count: Object.keys(room.users).length,
    max:   MAX_ROOM_MEMBERS,
  });
  for (const ws of Object.values(room.sockets)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─── SANITIZATION ──────────────────────────────────────────────────────────

function cleanText(text) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, MAX_MESSAGE_LEN);
}

function cleanUsername(name) {
  if (typeof name !== "string") return "";
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "").trim().slice(0, MAX_USERNAME_LEN);
}

function cleanRoom(room) {
  if (typeof room !== "string") return "";
  return room.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_\-]/g, "").toLowerCase().trim().slice(0, 50);
}

// ─── PERIODIC CLEANUP ──────────────────────────────────────────────────────

setInterval(() => {
  for (const [name, room] of Object.entries(rooms)) {
    if (Object.keys(room.users).length === 0) delete rooms[name];
  }
}, 60_000);

// ─── START ─────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  iText Chat ready → http://localhost:${PORT}\n`);
});
