/**
 * itext — Anonymous Real-Time Chat Server
 * Node.js + ws  |  node server/server.js
 */

const { WebSocketServer, WebSocket } = require("ws");
const http  = require("http");
const fs    = require("fs");
const path  = require("path");

// ─── CONFIG ────────────────────────────────────────────────────────────────

const PORT               = process.env.PORT || 3000;
const MAX_USERNAME_LEN   = 20;
const MAX_MESSAGE_LEN    = 500;
const RATE_MAX           = 10;        // messages
const RATE_WINDOW_MS     = 5000;      // per 5 s
const TYPING_CLEAR_MS    = 3000;

// ─── ROOMS STORE ───────────────────────────────────────────────────────────
//
//  rooms = {
//    roomName: {
//      users:   { socketId: username },
//      sockets: { socketId: ws }
//    }
//  }

const rooms      = {};
const clientMeta = {};   // socketId → { room, username, rateWindow[], typingTimer }
let   nextId     = 1;
const genId      = () => String(nextId++);

// ─── HTTP (serves ./client static files) ───────────────────────────────────

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"application/javascript" };

const httpServer = http.createServer((req, res) => {
  const safePath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const filePath = path.join(__dirname, "../client", safePath);
  const ext      = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[ext] || "text/plain" });
    res.end(data);
  });
});

// ─── WEBSOCKET SERVER ──────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const socketId = genId();
  clientMeta[socketId] = { room: null, username: null, rateWindow: [], typingTimer: null };

  console.log(`[+] ${socketId} connected`);

  // Tell the client its own socketId so it can identify self-messages
  sendTo(ws, { type: "welcome", socketId });

  ws.on("message", (raw) => {
    let data;
    try { data = JSON.parse(raw); } catch { return; }

    switch (data.type) {
      case "join_room":    handleJoin(socketId, ws, data);    break;
      case "send_message": handleMessage(socketId, ws, data); break;
      case "typing":       handleTyping(socketId, data);      break;
      case "nick":         handleNick(socketId, ws, data);    break;
    }
  });

  ws.on("close", () => handleDisconnect(socketId));
  ws.on("error", () => handleDisconnect(socketId));
});

// ─── JOIN ──────────────────────────────────────────────────────────────────

function handleJoin(socketId, ws, data) {
  const meta     = clientMeta[socketId];
  const roomName = cleanRoom(data.room);
  const username = cleanUsername(data.username);

  if (!roomName || !username) {
    sendTo(ws, { type: "error", text: "Invalid room or username." });
    return;
  }

  if (meta.room) leaveRoom(socketId);   // leave previous room if switching

  if (!rooms[roomName]) rooms[roomName] = { users: {}, sockets: {} };

  const room = rooms[roomName];
  room.users[socketId]   = username;
  room.sockets[socketId] = ws;
  meta.room     = roomName;
  meta.username = username;

  console.log(`[>] ${username}(${socketId}) → #${roomName}  (${Object.keys(room.users).length} users)`);

  // Confirm to the joining user
  sendTo(ws, {
    type:     "joined",
    room:     roomName,
    username,
    users:    Object.values(room.users),
  });

  // Notify everyone else
  broadcast(roomName, {
    type:      "system",
    text:      `${username} joined`,
    timestamp: Date.now(),
  }, socketId);

  broadcastUserList(roomName);
}

// ─── MESSAGE ───────────────────────────────────────────────────────────────

function handleMessage(socketId, ws, data) {
  const meta = clientMeta[socketId];
  if (!meta.room) return;

  // Rate limit
  const now = Date.now();
  meta.rateWindow = meta.rateWindow.filter(t => now - t < RATE_WINDOW_MS);
  if (meta.rateWindow.length >= RATE_MAX) {
    sendTo(ws, { type: "error", text: "Too fast! Slow down." });
    return;
  }
  meta.rateWindow.push(now);

  // Validate text — server sends RAW text; client is responsible for escaping
  const text = cleanText(data.text);
  if (!text) return;

  broadcast(meta.room, {
    type:      "message",
    socketId,                   // client uses this to decide left/right alignment
    username:  meta.username,
    text,                       // plain text, NOT HTML-escaped — client escapes on render
    timestamp: Date.now(),
  });

  stopTyping(socketId);
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
  if (!newName) { sendTo(ws, { type: "error", text: "Invalid name." }); return; }

  const oldName = meta.username;
  meta.username = newName;
  rooms[meta.room].users[socketId] = newName;

  sendTo(ws, { type: "nick_ok", username: newName });
  broadcast(meta.room, {
    type: "system", text: `${oldName} is now ${newName}`, timestamp: Date.now(),
  }, socketId);
  broadcastUserList(meta.room);
}

// ─── DISCONNECT ────────────────────────────────────────────────────────────

function handleDisconnect(socketId) {
  const meta = clientMeta[socketId];
  if (!meta) return;
  console.log(`[-] ${meta.username}(${socketId}) disconnected`);
  leaveRoom(socketId);
  delete clientMeta[socketId];
}

// ─── HELPERS ───────────────────────────────────────────────────────────────

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

  if (Object.keys(room.users).length === 0) { delete rooms[roomName]; return; }

  broadcast(roomName, { type: "system", text: `${username} left`, timestamp: Date.now() });
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

function broadcastUserList(roomName) {
  const room = rooms[roomName];
  if (!room) return;
  const payload = JSON.stringify({ type: "user_list", users: Object.values(room.users) });
  for (const ws of Object.values(room.sockets)) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

// ─── SANITIZATION ──────────────────────────────────────────────────────────
// Server only validates/trims; HTML escaping is done by the CLIENT on render.

function cleanText(text) {
  if (typeof text !== "string") return "";
  return text.trim().slice(0, MAX_MESSAGE_LEN);
}

function cleanUsername(name) {
  if (typeof name !== "string") return "";
  // Allow letters, numbers, underscore, hyphen, dot
  return name.replace(/[^a-zA-Z0-9_\-\.]/g, "").trim().slice(0, MAX_USERNAME_LEN);
}

function cleanRoom(room) {
  if (typeof room !== "string") return "";
  return room.replace(/\s+/g, "-").replace(/[^a-zA-Z0-9_\-]/g, "").toLowerCase().trim().slice(0, 50);
}

// ─── START ─────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n  itext ready → http://localhost:${PORT}\n`);
});
