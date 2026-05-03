/**
 * iText Chat — Frontend Client
 * Vanilla JS · No frameworks
 * Features: Media sharing · Reactions · Reply-to · Read receipts · Auto-reconnect · Room switching
 */

"use strict";

// ─── CONSTANTS ────────────────────────────────────────────────────────────

const CONSEC_MS         = 60_000;   // group consecutive msgs within 1 min
const MAX_FILE_MB       = 10;
const PING_INTERVAL_MS  = 25_000;
const RECONNECT_DELAYS  = [2000, 4000, 8000, 15000, 30000]; // longer — handles Render cold-start
const REACTIONS         = ["👍","❤️","😂","😮","😢","🔥","👏","🎉","💯","😎"];

// ─── SERVER URL ───────────────────────────────────────────────────────────
// Static client is on Firebase; WebSocket server is on Render.
// Change this if you self-host everything on the same origin.
const WS_SERVER = "wss://itext-chat.onrender.com";

// ─── STATE ────────────────────────────────────────────────────────────────

const state = {
  ws:              null,
  socketId:        null,
  username:        null,
  room:            null,
  users:           [],
  typingUsers:     {},
  typingTimer:     null,
  isTyping:        false,
  lastSenderId:    null,
  lastSenderTime:  0,
  replyTo:         null,      // { msgId, username, text }
  messages:        {},        // msgId → DOM element
  reconnectTimer:  null,
  reconnectCount:  0,
  manualClose:     false,
  maxRoom:         100,
  roomCount:       0,
  rooms:           new Set(), // rooms we've joined this session
};

// ─── DOM ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const joinScreen       = $("join-screen");
const chatScreen       = $("chat-screen");
const inputUsername    = $("input-username");
const inputRoom        = $("input-room");
const btnJoin          = $("btn-join");
const joinError        = $("join-error");
const messagesEl       = $("messages");
const msgInput         = $("msg-input");
const btnSend          = $("btn-send");
const roomNameEl       = $("room-name");
const headerRoomEl     = $("header-room-name");
const userListEl       = $("user-list");
const userCountEl      = $("user-count");
const headerCount      = $("header-user-count");
const typingBar        = $("typing-bar");
const btnLeave         = $("btn-leave");
const sidebar          = $("sidebar");
const sidebarBackdrop  = $("sidebar-backdrop");
const btnSidebarToggle = $("btn-sidebar-toggle");
const helpOverlay      = $("help-overlay");
const btnCloseHelp     = $("btn-close-help");
const lightbox         = $("lightbox");
const lightboxImg      = $("lightbox-img");
const reactionPicker   = $("reaction-picker");
const toastContainer   = $("toast-container");
const connStatus       = $("conn-status");
const liveDot          = $("live-dot");
const capFill          = $("cap-fill");
const capText          = $("cap-text");
const capPct           = $("cap-pct");
const replyBar         = $("reply-bar");
const replyPreviewText = $("reply-preview-text");
const btnCancelReply   = $("btn-cancel-reply");
const btnAttach        = $("btn-attach");
const attachMenu       = $("attach-menu");
const uploadProgress   = $("upload-progress");
const uploadProgressBar= $("upload-progress-bar");
const roomsList        = $("rooms-list");

// ─── UTILS ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" });
}

function fmtSize(bytes) {
  if (bytes < 1024)        return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(1)} MB`;
}

function fileIcon(mimeType) {
  if (mimeType?.startsWith("application/pdf")) return "📄";
  if (mimeType?.startsWith("text/"))           return "📝";
  if (mimeType?.includes("zip"))               return "🗜️";
  return "📎";
}

function mediaCat(mimeType) {
  if (mimeType?.startsWith("image/")) return "image";
  if (mimeType?.startsWith("video/")) return "video";
  if (mimeType?.startsWith("audio/")) return "audio";
  return "document";
}

// ─── TOAST ────────────────────────────────────────────────────────────────

function toast(text, type = "info", duration = 3000) {
  const el = document.createElement("div");
  el.className   = `toast ${type}`;
  el.textContent = text;
  toastContainer.appendChild(el);
  setTimeout(() => el.remove(), duration + 300);
}

// ─── SIDEBAR ──────────────────────────────────────────────────────────────

function openSidebar()   { sidebar.classList.add("open"); sidebarBackdrop.classList.add("visible"); }
function closeSidebar()  { sidebar.classList.remove("open"); sidebarBackdrop.classList.remove("visible"); }
function toggleSidebar() { sidebar.classList.contains("open") ? closeSidebar() : openSidebar(); }

// ─── ROOM CHIPS ───────────────────────────────────────────────────────────

function addRoomChip(roomName) {
  if (roomsList.querySelector(`[data-room="${CSS.escape(roomName)}"]`)) return;
  state.rooms.add(roomName);
  const btn = document.createElement("button");
  btn.className        = "room-item";
  btn.dataset.room     = roomName;
  btn.innerHTML        = `<span class="room-item-name"># ${esc(roomName)}</span>`;
  roomsList.appendChild(btn);
}

function setActiveRoomChip(roomName) {
  roomsList.querySelectorAll(".room-item").forEach(el => {
    el.classList.toggle("active", el.dataset.room === roomName);
  });
}

function switchRoom(roomName) {
  const clean = roomName.trim().replace(/\s+/g, "-").toLowerCase();
  if (!clean || !state.username) return;
  addRoomChip(clean);
  setActiveRoomChip(clean);
  wsSend({ type: "join_room", username: state.username, room: clean });
}

// ─── WEBSOCKET SEND ───────────────────────────────────────────────────────

function wsSend(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ─── PING ─────────────────────────────────────────────────────────────────

let pingTimer = null;

function startPing() {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => wsSend({ type: "ping", t: Date.now() }), PING_INTERVAL_MS);
}

function stopPing() { clearInterval(pingTimer); }

// ─── CONNECT / RECONNECT ──────────────────────────────────────────────────

function connect(username, room) {
  state.manualClose = false;
  clearTimeout(state.reconnectTimer);

  // Always connect to the Render WebSocket server.
  // Firebase only hosts static files — it does NOT proxy WebSockets.
  const ws = new WebSocket(WS_SERVER);
  state.ws = ws;

  // Show a connecting status so user knows it's working
  if (state.reconnectCount === 0) {
    connStatus.textContent = "Connecting…";
    connStatus.classList.add("visible");
  }

  ws.addEventListener("open", () => {
    state.reconnectCount = 0;
    connStatus.classList.remove("visible");
    liveDot.classList.remove("offline");
    wsSend({
      type:     "join_room",
      username: username || state.username,
      room:     room     || state.room,
    });
    startPing();
  });

  ws.addEventListener("message", ({ data }) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    handleServerMessage(msg);
  });

  ws.addEventListener("close", () => {
    stopPing();
    liveDot.classList.add("offline");
    if (!state.manualClose) scheduleReconnect();
  });

  ws.addEventListener("error", () => {}); // close event fires right after, handles it
}

function scheduleReconnect() {
  if (state.manualClose) return;
  const delay = RECONNECT_DELAYS[Math.min(state.reconnectCount, RECONNECT_DELAYS.length - 1)];
  state.reconnectCount++;

  // First few attempts: Render free tier may be cold-starting (takes ~30s)
  const isColdStart = state.reconnectCount <= 3;
  connStatus.textContent = isColdStart
    ? `Server waking up… retrying in ${delay / 1000}s`
    : `Reconnecting in ${delay / 1000}s…`;
  connStatus.classList.add("visible");

  state.reconnectTimer = setTimeout(() => connect(), delay);
}

// ─── SERVER MESSAGE HANDLER ───────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case "welcome":
      state.socketId = msg.socketId;
      state.maxRoom  = msg.maxRoom || 100;
      break;

    case "joined":
      state.room     = msg.room;
      state.username = msg.username;
      state.users    = msg.users || [];
      updateRoomCapacity(msg.count || 0, msg.max || 100);
      showChatScreen();
      addRoomChip(msg.room);
      setActiveRoomChip(msg.room);
      break;

    case "user_list":
      state.users     = msg.users || [];
      state.roomCount = msg.count || state.users.length;
      renderUserList();
      updateRoomCapacity(msg.count || 0, msg.max || 100);
      break;

    case "message":
      appendMessage(msg);
      break;

    case "media":
      appendMedia(msg);
      break;

    case "system":
      appendSystem(msg);
      break;

    case "typing":
      handleTypingIndicator(msg);
      break;

    case "reaction":
      handleReactionUpdate(msg);
      break;

    case "read":
      handleReadReceipt(msg);
      break;

    case "nick_ok":
      state.username = msg.username;
      toast(`You are now "${msg.username}"`, "success");
      break;

    case "error":
      handleError(msg);
      break;

    case "pong":
      break;
  }
}

// ─── SCREEN TRANSITIONS ───────────────────────────────────────────────────

function showChatScreen() {
  joinScreen.classList.remove("active");
  chatScreen.classList.add("active");

  const tag = `#${state.room}`;
  roomNameEl.textContent   = tag;
  headerRoomEl.textContent = tag;
  document.title           = `${tag} — iText Chat`;

  renderUserList();
  msgInput.focus();
}

function showJoinScreen() {
  chatScreen.classList.remove("active");
  joinScreen.classList.add("active");
  messagesEl.innerHTML = "";
  typingBar.innerHTML  = "";
  state.messages   = {};
  state.replyTo    = null;
  state.lastSenderId = null;
  replyBar.classList.remove("visible");
  document.title = "iText Chat";
}

// ─── ROOM CAPACITY ────────────────────────────────────────────────────────

function updateRoomCapacity(count, max) {
  const pct = Math.round((count / max) * 100);
  capFill.style.width = `${pct}%`;
  capText.textContent = `${count} / ${max} members`;
  capPct.textContent  = `${pct}%`;
  capFill.classList.toggle("warning", pct >= 80 && pct < 100);
  capFill.classList.toggle("full",    pct >= 100);
  state.roomCount = count;
  headerCount.textContent = `${count} online`;
}

// ─── USER LIST ────────────────────────────────────────────────────────────

function renderUserList() {
  userListEl.innerHTML     = "";
  userCountEl.textContent  = state.users.length;

  state.users.forEach(u => {
    const li = document.createElement("li");
    li.className = u === state.username ? "self" : "";
    li.innerHTML = `<span class="user-dot"></span><span>${esc(u)}${u === state.username ? " (you)" : ""}</span>`;
    userListEl.appendChild(li);
  });
}

// ─── APPEND MESSAGE ───────────────────────────────────────────────────────

function appendMessage(msg) {
  const { msgId, socketId, username, text, replyTo, timestamp } = msg;
  const isSelf   = socketId === state.socketId;
  const now      = timestamp || Date.now();
  const isConsec = state.lastSenderId === socketId &&
                   (now - state.lastSenderTime) < CONSEC_MS;

  const row = document.createElement("div");
  row.className = `msg-row ${isSelf ? "self" : "other"}${isConsec ? " consec" : ""}`;
  row.dataset.msgId = msgId || "";

  let replyHTML = "";
  if (replyTo) {
    const orig = state.messages[replyTo];
    const preview = orig ? orig.dataset.preview || "Message" : "Message";
    replyHTML = `<div class="msg-reply-preview">${esc(preview.slice(0, 60))}</div>`;
  }

  row.innerHTML = `
    <div class="msg-meta">
      <span class="msg-username">${esc(username)}</span>
      <span class="msg-time">${fmtTime(now)}</span>
    </div>
    ${replyHTML}
    <div class="msg-bubble">${esc(text)}</div>
    <div class="msg-reactions" id="reactions-${esc(msgId)}"></div>
    ${isSelf ? `<div class="msg-read" id="read-${esc(msgId)}">✓ Sent</div>` : ""}
    <div class="msg-actions">
      <button class="msg-action-btn" data-action="react" data-msg-id="${esc(msgId)}" title="React">😊</button>
      <button class="msg-action-btn" data-action="reply" data-msg-id="${esc(msgId)}" data-username="${esc(username)}" data-text="${esc(text)}" title="Reply">↩</button>
    </div>
  `;

  row.dataset.preview = text;

  messagesEl.appendChild(row);
  if (msgId) state.messages[msgId] = row;

  state.lastSenderId  = socketId;
  state.lastSenderTime = now;

  scrollToBottom();
  playBeep();

  // Send read receipt for others' messages
  if (!isSelf && msgId) {
    setTimeout(() => sendReadReceipt(msgId), 500);
  }

  // Mobile long-press for reactions
  addLongPress(row, msgId, username, text);
}

// ─── APPEND MEDIA ─────────────────────────────────────────────────────────

function appendMedia(msg) {
  const { msgId, socketId, username, mediaType, fileName, mimeType, data: b64, size, timestamp } = msg;
  const isSelf   = socketId === state.socketId;
  const now      = timestamp || Date.now();
  const isConsec = state.lastSenderId === socketId &&
                   (now - state.lastSenderTime) < CONSEC_MS;

  const row = document.createElement("div");
  row.className = `msg-row ${isSelf ? "self" : "other"}${isConsec ? " consec" : ""}`;
  row.dataset.msgId = msgId || "";

  const src = `data:${mimeType};base64,${b64}`;
  let mediaHTML = "";

  if (mediaType === "image") {
    mediaHTML = `<img class="msg-image" src="${src}" alt="${esc(fileName)}" loading="lazy" />`;
  } else if (mediaType === "video") {
    mediaHTML = `<video class="msg-video" src="${src}" controls preload="metadata"></video>`;
  } else if (mediaType === "audio") {
    mediaHTML = `<audio class="msg-audio" src="${src}" controls></audio>`;
  } else {
    mediaHTML = `
      <a class="msg-file" href="${src}" download="${esc(fileName)}" target="_blank">
        <span class="msg-file-icon">${fileIcon(mimeType)}</span>
        <div class="msg-file-info">
          <div class="msg-file-name">${esc(fileName)}</div>
          <div class="msg-file-size">${fmtSize(size || 0)}</div>
        </div>
      </a>`;
  }

  row.innerHTML = `
    <div class="msg-meta">
      <span class="msg-username">${esc(username)}</span>
      <span class="msg-time">${fmtTime(now)}</span>
    </div>
    ${mediaHTML}
    <div class="msg-reactions" id="reactions-${esc(msgId)}"></div>
    <div class="msg-actions">
      <button class="msg-action-btn" data-action="react" data-msg-id="${esc(msgId)}" title="React">😊</button>
    </div>
  `;

  row.dataset.preview = `[${mediaType}] ${fileName}`;

  // Lightbox for images
  if (mediaType === "image") {
    const img = row.querySelector(".msg-image");
    img?.addEventListener("click", () => openLightbox(src));
  }

  messagesEl.appendChild(row);
  if (msgId) state.messages[msgId] = row;

  state.lastSenderId   = socketId;
  state.lastSenderTime = now;

  scrollToBottom();
  playBeep();
  addLongPress(row, msgId, username, fileName);
}

// ─── APPEND SYSTEM ────────────────────────────────────────────────────────

function appendSystem(msg) {
  const el = document.createElement("div");
  el.className   = `msg-system${msg.warning ? " warning" : ""}`;
  el.textContent = msg.text + (msg.timestamp ? `  ${fmtTime(msg.timestamp)}` : "");
  messagesEl.appendChild(el);
  state.lastSenderId = null;
  scrollToBottom();
}

// ─── TYPING INDICATOR ─────────────────────────────────────────────────────

function handleTypingIndicator({ username, isTyping }) {
  clearTimeout(state.typingUsers[username]);
  if (isTyping) {
    state.typingUsers[username] = setTimeout(() => {
      delete state.typingUsers[username];
      renderTypingBar();
    }, 4000);
  } else {
    delete state.typingUsers[username];
  }
  renderTypingBar();
}

function renderTypingBar() {
  const names = Object.keys(state.typingUsers);
  if (!names.length) {
    typingBar.innerHTML = "";
    return;
  }
  const dotsHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;
  const who = names.length === 1
    ? `${esc(names[0])} is typing`
    : names.length <= 3
      ? `${names.map(esc).join(", ")} are typing`
      : "Several people are typing";
  typingBar.innerHTML = `${dotsHTML}${who}…`;
}

// ─── REACTIONS ────────────────────────────────────────────────────────────

// reactions[msgId][emoji] = Set of usernames
const reactionData = {};

function handleReactionUpdate(msg) {
  const { msgId, emoji, username, socketId } = msg;
  if (!reactionData[msgId]) reactionData[msgId] = {};
  if (!reactionData[msgId][emoji]) reactionData[msgId][emoji] = new Set();
  // Toggle: if user reacts again remove it
  if (reactionData[msgId][emoji].has(username)) {
    reactionData[msgId][emoji].delete(username);
  } else {
    reactionData[msgId][emoji].add(username);
  }
  if (reactionData[msgId][emoji].size === 0) delete reactionData[msgId][emoji];
  renderReactions(msgId);
}

function renderReactions(msgId) {
  const container = $(`reactions-${msgId}`);
  if (!container) return;
  container.innerHTML = "";
  const data = reactionData[msgId] || {};
  for (const [emoji, users] of Object.entries(data)) {
    if (users.size === 0) continue;
    const isMine = users.has(state.username);
    const chip   = document.createElement("button");
    chip.className     = `reaction-chip${isMine ? " mine" : ""}`;
    chip.title         = [...users].join(", ");
    chip.dataset.msgId = msgId;
    chip.dataset.emoji = emoji;
    chip.innerHTML     = `${emoji}<span class="reaction-count">${users.size}</span>`;
    chip.addEventListener("click", () => {
      wsSend({ type: "reaction", msgId, emoji });
    });
    container.appendChild(chip);
  }
}

// ─── REACTION PICKER ──────────────────────────────────────────────────────

// Build picker once
REACTIONS.forEach(emoji => {
  const btn = document.createElement("button");
  btn.textContent = emoji;
  btn.title = emoji;
  btn.addEventListener("click", () => {
    const msgId = reactionPicker.dataset.msgId;
    if (msgId) wsSend({ type: "reaction", msgId, emoji });
    hideReactionPicker();
  });
  reactionPicker.appendChild(btn);
});

function showReactionPicker(msgId, anchor) {
  reactionPicker.dataset.msgId = msgId;
  reactionPicker.style.display = "flex";
  const rect = anchor.getBoundingClientRect();
  const pickerW = reactionPicker.offsetWidth || 300;
  let left = rect.left - 20;
  if (left + pickerW > window.innerWidth - 8) left = window.innerWidth - pickerW - 8;
  if (left < 8) left = 8;
  reactionPicker.style.left = `${left}px`;
  reactionPicker.style.top  = `${rect.top - 64}px`;
  setTimeout(() => {
    document.addEventListener("click", hideReactionPicker, { once: true });
  }, 10);
}

function hideReactionPicker() {
  reactionPicker.style.display = "";
  reactionPicker.dataset.msgId = "";
}

// ─── REPLY ────────────────────────────────────────────────────────────────

function setReply(msgId, username, text) {
  state.replyTo = { msgId, username, text };
  replyPreviewText.textContent = `↩ ${username}: ${(text || "Media").slice(0, 60)}`;
  replyBar.classList.add("visible");
  msgInput.focus();
}

function clearReply() {
  state.replyTo = null;
  replyBar.classList.remove("visible");
}

// ─── READ RECEIPTS ────────────────────────────────────────────────────────

function sendReadReceipt(msgId) {
  wsSend({ type: "read", msgId });
}

function handleReadReceipt(msg) {
  const el = $(`read-${msg.msgId}`);
  if (el && msg.socketId !== state.socketId) {
    el.textContent = `✓✓ Seen by ${esc(msg.username)}`;
    el.style.color = "var(--green)";
  }
}

// ─── LONG PRESS (MOBILE REACTIONS) ────────────────────────────────────────

function addLongPress(row, msgId, username, text) {
  if (!msgId) return;
  const bubble = row.querySelector(".msg-bubble, .msg-image, .msg-file");
  if (!bubble) return;
  let timer = null;
  bubble.addEventListener("touchstart", e => {
    timer = setTimeout(() => {
      const touch = e.touches[0];
      showReactionPicker(msgId, {
        getBoundingClientRect: () => ({ left: touch.clientX, top: touch.clientY }),
      });
    }, 500);
  }, { passive: true });
  bubble.addEventListener("touchend",    () => clearTimeout(timer));
  bubble.addEventListener("touchmove",   () => clearTimeout(timer));
  bubble.addEventListener("touchcancel", () => clearTimeout(timer));
}

// ─── LIGHTBOX ─────────────────────────────────────────────────────────────

function openLightbox(src) {
  lightboxImg.src = src;
  lightbox.classList.add("open");
}
lightbox.addEventListener("click", () => lightbox.classList.remove("open"));

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;

  if (text.startsWith("/")) {
    handleCommand(text);
    msgInput.value = "";
    autoResize();
    return;
  }

  wsSend({
    type:    "send_message",
    text,
    replyTo: state.replyTo?.msgId || null,
  });

  msgInput.value = "";
  autoResize();
  clearReply();
  stopTypingSignal();
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────

function handleCommand(raw) {
  const parts = raw.slice(1).trim().split(/\s+/);
  const cmd   = parts[0].toLowerCase();
  switch (cmd) {
    case "nick":
      if (parts[1]) wsSend({ type: "nick", username: parts[1] });
      else addSystemLocal("Usage: /nick <newname>");
      break;
    case "clear":
      messagesEl.innerHTML = "";
      state.messages       = {};
      state.lastSenderId   = null;
      toast("Chat cleared locally", "success");
      break;
    case "help":
      helpOverlay.classList.remove("hidden");
      break;
    default:
      toast(`Unknown command: /${cmd}. Type /help`, "error");
  }
}

function addSystemLocal(text) {
  const el = document.createElement("div");
  el.className   = "msg-system";
  el.textContent = text;
  messagesEl.appendChild(el);
  scrollToBottom();
}

// ─── TYPING SIGNALS ───────────────────────────────────────────────────────

function startTypingSignal() {
  if (!state.isTyping) {
    state.isTyping = true;
    wsSend({ type: "typing", isTyping: true });
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTypingSignal, 3000);
}

function stopTypingSignal() {
  if (state.isTyping) {
    state.isTyping = false;
    wsSend({ type: "typing", isTyping: false });
  }
  clearTimeout(state.typingTimer);
}

// ─── TEXTAREA AUTO RESIZE ─────────────────────────────────────────────────

function autoResize() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 140) + "px";
}

// ─── FILE UPLOAD ──────────────────────────────────────────────────────────

async function handleFileSelected(file) {
  if (!file) return;
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    toast(`File too large! Max ${MAX_FILE_MB} MB.`, "error");
    return;
  }

  showUploadProgress(0);
  toast("Preparing to send…", "info", 1500);

  try {
    const b64 = await fileToBase64WithProgress(file, pct => showUploadProgress(pct));
    wsSend({
      type:      "send_media",
      mediaType: mediaCat(file.type),
      fileName:  file.name,
      mimeType:  file.type || "application/octet-stream",
      data:      b64,
      size:      file.size,
    });
    hideUploadProgress();
    toast("Sent!", "success", 1500);
  } catch {
    hideUploadProgress();
    toast("Failed to send file.", "error");
  }
}

function fileToBase64WithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    let pct = 0;
    const iv = setInterval(() => {
      pct = Math.min(pct + 15, 90);
      onProgress(pct);
    }, 100);
    reader.onload = e => {
      clearInterval(iv);
      onProgress(100);
      resolve(e.target.result.split(",")[1]);
    };
    reader.onerror = () => { clearInterval(iv); reject(new Error("Read failed")); };
    reader.readAsDataURL(file);
  });
}

function showUploadProgress(pct) {
  uploadProgress.classList.add("active");
  uploadProgressBar.style.width = `${pct}%`;
}

function hideUploadProgress() {
  setTimeout(() => {
    uploadProgress.classList.remove("active");
    uploadProgressBar.style.width = "0%";
  }, 400);
}

// ─── SCROLL ───────────────────────────────────────────────────────────────

function scrollToBottom() {
  const threshold = 200;
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < threshold;
  if (nearBottom) {
    requestAnimationFrame(() => { messagesEl.scrollTop = messagesEl.scrollHeight; });
  }
}

// ─── AUDIO BEEP ───────────────────────────────────────────────────────────

let _audio = null;
function playBeep() {
  try {
    if (!_audio) _audio = new (window.AudioContext || window.webkitAudioContext)();
    const o = _audio.createOscillator();
    const g = _audio.createGain();
    o.connect(g);
    g.connect(_audio.destination);
    o.type = "sine";
    o.frequency.setValueAtTime(1000, _audio.currentTime);
    o.frequency.exponentialRampToValueAtTime(700, _audio.currentTime + 0.1);
    g.gain.setValueAtTime(0.035, _audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, _audio.currentTime + 0.18);
    o.start();
    o.stop(_audio.currentTime + 0.18);
  } catch { /* Audio blocked or unavailable */ }
}

// ─── ERROR HANDLER ────────────────────────────────────────────────────────

function handleError(msg) {
  switch (msg.code) {
    case "ROOM_FULL":
      joinError.textContent = msg.text;
      joinError.classList.remove("hidden");
      showJoinScreen();
      toast(msg.text, "error", 5000);
      break;
    case "RATE_LIMIT":
      toast("⚡ Slow down!", "warning");
      break;
    case "FILE_TOO_LARGE":
      toast(msg.text, "error");
      break;
    case "UNSUPPORTED_MEDIA":
      toast(msg.text, "error");
      break;
    default:
      toast(msg.text || "An error occurred", "error");
  }
}

// ─── BOOT ─────────────────────────────────────────────────────────────────

(function boot() {
  // Pre-fill from URL ?room=
  const params = new URLSearchParams(location.search);
  const roomParam = params.get("room");
  if (roomParam) inputRoom.value = roomParam;

  // Restore saved username
  const saved = localStorage.getItem("itext_username");
  if (saved) inputUsername.value = saved;

  // Focus first empty field
  (!inputUsername.value ? inputUsername : inputRoom).focus();

  // ── Join ──
  btnJoin.addEventListener("click", doJoin);
  [inputUsername, inputRoom].forEach(el =>
    el.addEventListener("keydown", e => { if (e.key === "Enter") doJoin(); })
  );

  function doJoin() {
    const username = inputUsername.value.trim();
    const room     = (inputRoom.value.trim().replace(/\s+/g, "-") || "lounge").toLowerCase();

    joinError.classList.add("hidden");

    if (!username)           return showJoinError("Please enter a name.");
    if (username.length > 20) return showJoinError("Name too long (max 20 chars).");
    if (!/^[a-zA-Z0-9_\-\.]+$/.test(username))
      return showJoinError("Name: letters, numbers, _ - . only.");

    localStorage.setItem("itext_username", username);

    const url = new URL(location.href);
    url.searchParams.set("room", room);
    history.replaceState({}, "", url);

    btnJoin.disabled    = true;
    btnJoin.textContent = "Connecting…";

    connect(username, room);

    // Re-enable after 8s in case server is cold-starting (Render free tier ~30s wake)
    // The 'joined' event will switch the screen; this just unblocks the button if it fails
    setTimeout(() => {
      if (joinScreen.classList.contains("active")) {
        btnJoin.disabled    = false;
        btnJoin.textContent = "Join Room →";
      }
    }, 8000);
  }

  function showJoinError(msg) {
    joinError.textContent = msg;
    joinError.classList.remove("hidden");
    btnJoin.disabled    = false;
    btnJoin.textContent = "Join Room →";
  }

  // ── Sidebar ──
  btnSidebarToggle.addEventListener("click", toggleSidebar);
  sidebarBackdrop.addEventListener("click", closeSidebar);

  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeSidebar();
      if (!helpOverlay.classList.contains("hidden")) helpOverlay.classList.add("hidden");
      hideReactionPicker();
    }
  });

  // ── Send ──
  btnSend.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener("input", () => {
    autoResize();
    if (msgInput.value.length > 0) startTypingSignal(); else stopTypingSignal();
  });

  // ── Leave ──
  btnLeave.addEventListener("click", () => {
    state.manualClose = true;
    state.ws?.close();
    stopPing();
    closeSidebar();
    state.rooms.clear();
    roomsList.innerHTML = "";
    showJoinScreen();
    inputUsername.focus();
  });

  // ── Help ──
  btnCloseHelp.addEventListener("click", () => helpOverlay.classList.add("hidden"));
  helpOverlay.addEventListener("click", e => {
    if (e.target === helpOverlay) helpOverlay.classList.add("hidden");
  });

  // ── Room chips ──
  roomsList.addEventListener("click", e => {
    const item = e.target.closest(".room-item");
    if (!item) return;
    switchRoom(item.dataset.room);
    closeSidebar();
  });

  // ── New room input ──
  $("btn-new-room").addEventListener("click", switchFromNewRoomInput);
  $("new-room-input").addEventListener("keydown", e => {
    if (e.key === "Enter") switchFromNewRoomInput();
  });

  function switchFromNewRoomInput() {
    const val = $("new-room-input").value.trim();
    if (!val) return;
    $("new-room-input").value = "";
    switchRoom(val);
    closeSidebar();
  }

  // ── Attach menu ──
  btnAttach.addEventListener("click", e => {
    e.stopPropagation();
    attachMenu.classList.toggle("open");
  });
  document.addEventListener("click", e => {
    if (!attachMenu.contains(e.target) && e.target !== btnAttach) {
      attachMenu.classList.remove("open");
    }
  });

  $("attach-image").addEventListener("click", () => { $("file-input-image").click(); attachMenu.classList.remove("open"); });
  $("attach-video").addEventListener("click", () => { $("file-input-video").click(); attachMenu.classList.remove("open"); });
  $("attach-audio").addEventListener("click", () => { $("file-input-audio").click(); attachMenu.classList.remove("open"); });
  $("attach-doc").addEventListener("click",   () => { $("file-input-doc").click();   attachMenu.classList.remove("open"); });

  $("file-input-image").addEventListener("change", e => { handleFileSelected(e.target.files[0]); e.target.value = ""; });
  $("file-input-video").addEventListener("change", e => { handleFileSelected(e.target.files[0]); e.target.value = ""; });
  $("file-input-audio").addEventListener("change", e => { handleFileSelected(e.target.files[0]); e.target.value = ""; });
  $("file-input-doc").addEventListener("change",   e => { handleFileSelected(e.target.files[0]); e.target.value = ""; });

  // ── Reply cancel ──
  btnCancelReply.addEventListener("click", clearReply);

  // ── Message action delegation ──
  messagesEl.addEventListener("click", e => {
    const btn = e.target.closest(".msg-action-btn");
    if (!btn) return;
    const action = btn.dataset.action;
    const msgId  = btn.dataset.msgId;
    if (action === "react") showReactionPicker(msgId, btn);
    else if (action === "reply") setReply(msgId, btn.dataset.username, btn.dataset.text);
  });

  // ── Drag & drop anywhere ──
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
    e.preventDefault();
    if (!state.room) return;
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileSelected(file);
  });

  // ── Paste image ──
  document.addEventListener("paste", e => {
    if (!state.room) return;
    for (const item of (e.clipboardData?.items || [])) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) { handleFileSelected(file); break; }
      }
    }
  });

  // ── iOS viewport fix ──
  window.visualViewport?.addEventListener("resize", () => {
    document.documentElement.style.setProperty(
      "--vh", `${window.visualViewport.height * 0.01}px`
    );
  });

  // ── Initial resize ──
  autoResize();
})();
