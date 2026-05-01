/**
 * itext — Frontend Client v2
 * Vanilla JS · No frameworks · Green & Black · iOS-feel UI
 */

// ─── STATE ────────────────────────────────────────────────────────────────

const state = {
  ws:           null,
  socketId:     null,
  username:     null,
  room:         null,
  users:        [],
  typingTimer:  null,
  isTyping:     false,
  lastSenderId: null,
  typingUsers:  {},
};

// ─── DOM ──────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const joinScreen     = $("join-screen");
const chatScreen     = $("chat-screen");
const inputUsername  = $("input-username");
const inputRoom      = $("input-room");
const btnJoin        = $("btn-join");
const joinError      = $("join-error");
const messagesEl     = $("messages");
const msgInput       = $("msg-input");
const btnSend        = $("btn-send");
const roomNameEl     = $("room-name");
const headerRoomEl   = $("header-room-name");
const userListEl     = $("user-list");
const userCountEl    = $("user-count");
const headerCount    = $("header-user-count");
const typingBar      = $("typing-bar");
const btnLeave       = $("btn-leave");
const sidebar        = $("sidebar");
const sidebarBackdrop = $("sidebar-backdrop");
const btnSidebarToggle = $("btn-sidebar-toggle");
const helpOverlay    = $("help-overlay");
const btnCloseHelp   = $("btn-close-help");

// ─── WEBSOCKET SEND ───────────────────────────────────────────────────────

function wsSend(obj) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj));
  }
}

// ─── SIDEBAR HELPERS ──────────────────────────────────────────────────────

function openSidebar() {
  sidebar.classList.add("open");
  sidebarBackdrop.classList.add("visible");
  btnSidebarToggle.setAttribute("aria-expanded", "true");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarBackdrop.classList.remove("visible");
  btnSidebarToggle.setAttribute("aria-expanded", "false");
}

function toggleSidebar() {
  sidebar.classList.contains("open") ? closeSidebar() : openSidebar();
}

// ─── BOOT ─────────────────────────────────────────────────────────────────

(function boot() {
  // Pre-fill from URL ?room=
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get("room");
  if (roomParam) inputRoom.value = roomParam;

  // Restore saved username
  const saved = sessionStorage.getItem("itext_name");
  if (saved) inputUsername.value = saved;

  // Focus first empty field
  (!inputUsername.value ? inputUsername : inputRoom).focus();

  // Join screen
  btnJoin.addEventListener("click", attemptJoin);
  [inputUsername, inputRoom].forEach(el =>
    el.addEventListener("keydown", e => e.key === "Enter" && attemptJoin())
  );

  // Chat events
  btnSend.addEventListener("click", sendMessage);
  msgInput.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  msgInput.addEventListener("input", onTypingInput);
  btnLeave.addEventListener("click", leaveChat);

  // Sidebar
  btnSidebarToggle.addEventListener("click", toggleSidebar);
  sidebarBackdrop.addEventListener("click", closeSidebar);

  // Close sidebar on Escape
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      closeSidebar();
      if (!helpOverlay.classList.contains("hidden")) {
        helpOverlay.classList.add("hidden");
      }
    }
  });

  // Help overlay
  btnCloseHelp.addEventListener("click", () => helpOverlay.classList.add("hidden"));
  helpOverlay.addEventListener("click", e => {
    if (e.target === helpOverlay) helpOverlay.classList.add("hidden");
  });

  // iOS: fix viewport height on keyboard open
  window.visualViewport?.addEventListener("resize", () => {
    document.documentElement.style.setProperty(
      "--vh", `${window.visualViewport.height * 0.01}px`
    );
  });
})();

// ─── JOIN ─────────────────────────────────────────────────────────────────

function attemptJoin() {
  const username = inputUsername.value.trim();
  const room     = (inputRoom.value.trim().replace(/\s+/g, "-") || "lounge").toLowerCase();

  if (!username)          return showJoinError("Please enter a handle.");
  if (username.length > 20) return showJoinError("Handle too long (max 20 chars).");
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(username))
    return showJoinError("Handle: letters, numbers, _ - . only.");

  sessionStorage.setItem("itext_name", username);

  const url = new URL(location.href);
  url.searchParams.set("room", room);
  history.replaceState({}, "", url);

  btnJoin.textContent = "Connecting…";
  btnJoin.disabled    = true;
  joinError.classList.add("hidden");

  openWS(username, room);
}

function showJoinError(msg) {
  joinError.textContent = msg;
  joinError.classList.remove("hidden");
  // Re-trigger shake animation
  joinError.style.animation = "none";
  joinError.offsetHeight; // reflow
  joinError.style.animation = "";
  btnJoin.textContent = "Join Room →";
  btnJoin.disabled    = false;
}

// ─── WEBSOCKET ────────────────────────────────────────────────────────────

function openWS(username, room) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const SERVER_URL = "wss://itext-chat.onrender.com";
  const ws = new WebSocket(SERVER_URL);
  state.ws    = ws;

  ws.addEventListener("open", () => {
    wsSend({ type: "join_room", username, room });
  });

  ws.addEventListener("message", e => {
    let data;
    try { data = JSON.parse(e.data); } catch { return; }
    onServerEvent(data);
  });

  ws.addEventListener("close", () => {
    if (chatScreen.classList.contains("active"))
      addSystem("Disconnected. Reload the page to reconnect.");
  });

  ws.addEventListener("error", () => {
    showJoinError("Cannot reach server. Is it running?");
  });
}

// ─── SERVER EVENTS ────────────────────────────────────────────────────────

function onServerEvent(data) {
  switch (data.type) {
    case "welcome":
      state.socketId = data.socketId;
      break;

    case "joined":
      state.username = data.username;
      state.room     = data.room;
      openChatScreen(data);
      break;

    case "message":
      addMessage(data);
      break;

    case "system":
      addSystem(data.text, data.timestamp);
      break;

    case "user_list":
      renderUserList(data.users);
      break;

    case "typing":
      onTypingEvent(data);
      break;

    case "nick_ok":
      state.username = data.username;
      addSystem(`You are now "${data.username}"`);
      renderUserList(state.users);
      break;

    case "error":
      addSystem(`⚠ ${data.text}`);
      break;
  }
}

// ─── SCREEN SWITCH ────────────────────────────────────────────────────────

function openChatScreen(data) {
  joinScreen.classList.remove("active");
  joinScreen.style.display = "none";
  chatScreen.style.display = "flex";
  chatScreen.classList.add("active");

  const tag = `#${data.room}`;
  roomNameEl.textContent   = tag;
  headerRoomEl.textContent = tag;
  document.title           = `${tag} — itext`;

  renderUserList(data.users || []);

  const fresh = (data.users || []).length <= 1;
  addSystem(
    fresh
      ? `Room "${data.room}" created — share the URL to invite others.`
      : `Joined "${data.room}" — ${data.users.length} people here.`
  );

  msgInput.focus();
}

// ─── SEND MESSAGE ─────────────────────────────────────────────────────────

function sendMessage() {
  const text = msgInput.value.trim();
  if (!text) return;

  if (text.startsWith("/")) {
    runCommand(text);
  } else {
    wsSend({ type: "send_message", text });
  }

  msgInput.value = "";
  stopTypingSignal();
}

// ─── TYPING SIGNAL ────────────────────────────────────────────────────────

function onTypingInput() {
  if (!state.isTyping) {
    state.isTyping = true;
    wsSend({ type: "typing", isTyping: true });
  }
  clearTimeout(state.typingTimer);
  state.typingTimer = setTimeout(stopTypingSignal, 2000);
}

function stopTypingSignal() {
  if (!state.isTyping) return;
  state.isTyping = false;
  wsSend({ type: "typing", isTyping: false });
}

function onTypingEvent({ username, isTyping }) {
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
  if (!names.length)     { typingBar.textContent = ""; return; }
  if (names.length === 1) { typingBar.textContent = `${names[0]} is typing…`; return; }
  if (names.length <= 3)  { typingBar.textContent = `${names.join(", ")} are typing…`; return; }
  typingBar.textContent = "Several people are typing…";
}

// ─── COMMANDS ─────────────────────────────────────────────────────────────

function runCommand(raw) {
  const [cmd, ...args] = raw.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/nick":
      if (!args[0]) { addSystem("Usage: /nick <newname>"); return; }
      wsSend({ type: "nick", username: args[0] });
      break;
    case "/clear":
      messagesEl.innerHTML = "";
      state.lastSenderId   = null;
      addSystem("Chat cleared locally.");
      break;
    case "/help":
      helpOverlay.classList.remove("hidden");
      break;
    default:
      addSystem(`Unknown command "${cmd}". Type /help for a list.`);
  }
}

// ─── RENDER MESSAGES ──────────────────────────────────────────────────────

function addMessage({ socketId, username, text, timestamp }) {
  const isSelf    = socketId === state.socketId;
  const isGrouped = state.lastSenderId === socketId;

  const wrap = document.createElement("div");
  wrap.className = `msg ${isSelf ? "self" : "other"}${isGrouped ? " grouped" : ""}`;

  wrap.innerHTML = `
    <div class="msg-meta">
      <span class="uname">${esc(username)}</span>
      <span class="ts">${fmtTime(timestamp)}</span>
    </div>
    <div class="msg-bubble">${esc(text)}</div>
  `;

  messagesEl.appendChild(wrap);
  state.lastSenderId = socketId;
  scrollBottom();
  beep();
}

function addSystem(text, timestamp) {
  const el = document.createElement("div");
  el.className   = "msg-system";
  el.textContent = text + (timestamp ? `  ${fmtTime(timestamp)}` : "");
  messagesEl.appendChild(el);
  state.lastSenderId = null;
  scrollBottom();
}

function renderUserList(users) {
  state.users         = users || [];
  userListEl.innerHTML = "";
  for (const name of state.users) {
    const li = document.createElement("li");
    li.textContent = name;
    if (name === state.username) li.classList.add("is-self");
    userListEl.appendChild(li);
  }
  const n = state.users.length;
  userCountEl.textContent = n;
  headerCount.textContent = `${n} online`;
}

function scrollBottom() {
  // Smooth scroll, but instant if at bottom already
  const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (nearBottom) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// ─── LEAVE ────────────────────────────────────────────────────────────────

function leaveChat() {
  state.ws?.close();
  state.ws           = null;
  state.socketId     = null;
  state.lastSenderId = null;
  state.typingUsers  = {};
  typingBar.textContent = "";
  messagesEl.innerHTML  = "";
  closeSidebar();

  chatScreen.classList.remove("active");
  chatScreen.style.display = "none";
  joinScreen.style.display = "flex";
  joinScreen.classList.add("active");

  btnJoin.textContent = "Join Room →";
  btnJoin.disabled    = false;
  document.title      = "itext — anonymous chat";
  inputUsername.focus();
}

// ─── UTILS ────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtTime(ts) {
  return new Date(ts || Date.now()).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Subtle ping sound on new message
let _audio = null;
function beep() {
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
