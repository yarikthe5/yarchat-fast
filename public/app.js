// ══ STATE ══════════════════════════════════════════════════════════════
const S = {
  token: localStorage.getItem("yc_token"),
  me: JSON.parse(localStorage.getItem("yc_me") || "null"),
  chats: [],
  activeChat: null,
  replyTo: null,
  ctxMsg: null,
  saveMode: localStorage.getItem("yc_save") === "1",
  drawMode: false,
  markerMode: false,
  map: null,
  mapMarkers: {},
  drawPaths: [],
  currentPack: null,
};
const $ = id => document.getElementById(id);
const QUEUE_KEY = "yc_queue";
const CACHE_KEY = "yc_msgcache";
let socket = null;
let typingTimer = null;
let mediaRec = null;
let recChunks = [];
let recStart = 0;
let recInterval = null;
let pingInterval = null;

// ══ BOOT ═══════════════════════════════════════════════════════════════
window.addEventListener("load", () => {
  if (S.token && S.me) bootApp();
  // Enter on auth inputs
  ["loginPassword","regPassword"].forEach(id => {
    $(id)?.addEventListener("keydown", e => e.key === "Enter" && (id.startsWith("login") ? doLogin() : doRegister()));
  });
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
});

// ══ AUTH ════════════════════════════════════════════════════════════════
function showTab(t) {
  $("formLogin").classList.toggle("hidden", t !== "login");
  $("formReg").classList.toggle("hidden", t !== "reg");
  $("tabLogin").classList.toggle("active", t === "login");
  $("tabReg").classList.toggle("active", t !== "login");
  $("authError").classList.add("hidden");
}

async function doLogin() {
  const username = $("loginUsername").value.trim();
  const password = $("loginPassword").value;
  if (!username || !password) return showAuthErr("Заповни всі поля");
  await apiAuth("/api/login", { username, password });
}
async function doRegister() {
  const username = $("regUsername").value.trim();
  const displayName = $("regDisplayName").value.trim();
  const password = $("regPassword").value;
  if (!username || !password) return showAuthErr("Заповни всі поля");
  await apiAuth("/api/register", { username, displayName, password });
}
async function apiAuth(url, body) {
  $("authError").classList.add("hidden");
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    if (!r.ok) return showAuthErr(d.error || "Помилка");
    S.token = d.token; S.me = d.user;
    localStorage.setItem("yc_token", S.token);
    localStorage.setItem("yc_me", JSON.stringify(S.me));
    bootApp();
  } catch { showAuthErr("Немає зв'язку — перевір інтернет"); }
}
function showAuthErr(msg) { $("authError").textContent = msg; $("authError").classList.remove("hidden"); }
function doLogout() {
  localStorage.removeItem("yc_token"); localStorage.removeItem("yc_me");
  location.reload();
}

// ══ BOOT APP ════════════════════════════════════════════════════════════
function bootApp() {
  $("authScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  renderMyAvatar();
  initSocket();
  setupPush();
  if (S.saveMode) $("saveModeBtn").classList.add("active");
}

// ══ SOCKET ══════════════════════════════════════════════════════════════
function initSocket() {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 6000, auth: { token: S.token } });

  socket.on("connect", () => {
    socket.emit("auth", { token: S.token }, ({ ok, user, chats, error }) => {
      if (!ok) return;
      S.me = user; S.chats = chats || [];
      localStorage.setItem("yc_me", JSON.stringify(S.me));
      renderMyAvatar();
      renderChatList();
      flushQueue();
      startPing();
      // Auto-open last chat
      const lastChatId = localStorage.getItem("yc_lastchat");
      if (lastChatId) openChat(parseInt(lastChatId), true);
    });
  });

  socket.on("disconnect", () => setBars("bad"));

  socket.on("message", msg => {
    // Cache
    cacheMsg(msg);
    // If this chat is active → render
    if (msg.chat_id === S.activeChat) {
      const existing = document.querySelector(`[data-cid="${msg.client_id}"]`);
      if (existing) {
        existing.classList.remove("pending");
        const status = existing.querySelector(".msg-status");
        if (status) { status.textContent = "✓✓"; status.classList.add("sent"); }
      } else {
        appendMessage(msg);
        scrollBottom();
      }
    }
    // Update chat list preview
    updateChatPreview(msg);
  });

  socket.on("reaction-update", ({ messageId, reactions }) => {
    const el = document.querySelector(`[data-mid="${messageId}"] .msg-reactions`);
    if (el) el.innerHTML = buildReactions(messageId, reactions);
  });

  socket.on("message-edited", ({ messageId, content }) => {
    const el = document.querySelector(`[data-mid="${messageId}"] .msg-text`);
    if (el) { el.textContent = content; }
    const edited = document.querySelector(`[data-mid="${messageId}"] .msg-edited`);
    if (edited) edited.classList.remove("hidden");
  });

  socket.on("message-deleted", ({ messageId }) => {
    const el = document.querySelector(`[data-mid="${messageId}"]`);
    if (el) {
      el.querySelector(".msg-text") && (el.querySelector(".msg-text").textContent = "Повідомлення видалено");
      el.classList.add("deleted");
    }
  });

  socket.on("typing", ({ userId, displayName, chatId, isTyping }) => {
    if (chatId !== S.activeChat || userId === S.me.id) return;
    const bar = $("typingBar");
    if (isTyping) {
      bar.innerHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>${displayName} друкує...`;
      bar.classList.remove("hidden");
    } else bar.classList.add("hidden");
  });

  socket.on("presence", ({ userId, online }) => {
    // Could update avatar ring color — skip for brevity
  });

  socket.on("map-marker", marker => {
    if (S.map && marker.chatId === S.activeChat) addMapMarker(marker);
  });
  socket.on("map-draw", ({ paths }) => {
    if (S.map) renderMapDraw(paths);
  });
  socket.on("map-marker-deleted", ({ markerId }) => {
    if (S.mapMarkers[markerId]) { S.mapMarkers[markerId].remove(); delete S.mapMarkers[markerId]; }
  });
}

// ══ PING / CONNECTION QUALITY ══════════════════════════════════════════
function startPing() {
  clearInterval(pingInterval);
  pingInterval = setInterval(() => {
    if (!socket?.connected) return setBars("bad");
    const t0 = Date.now();
    socket.emit("ping-check", () => {
      const rtt = Date.now() - t0;
      setBars(rtt < 300 ? "good" : rtt < 800 ? "mid" : "bad");
    });
  }, 5000);
}
function setBars(level) {
  const el = $("connBars");
  if (el) el.className = "conn-bars " + level;
}

// ══ OFFLINE QUEUE ═══════════════════════════════════════════════════════
function getQueue() { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function pushQueue(item) { const q = getQueue(); q.push(item); setQueue(q); }
function removeQueue(clientId) { setQueue(getQueue().filter(m => m.clientId !== clientId)); }

function flushQueue() {
  getQueue().forEach(m => trySend(m));
}
function trySend(msg) {
  if (!socket?.connected) return;
  socket.emit("message", msg, ack => {
    if (ack?.ok) {
      removeQueue(msg.clientId);
      const el = document.querySelector(`[data-cid="${msg.clientId}"]`);
      if (el) { el.classList.remove("pending"); const s = el.querySelector(".msg-status"); if (s) { s.textContent = "✓✓"; s.classList.add("sent"); } }
    }
  });
}
window.addEventListener("online", () => socket?.connected ? flushQueue() : socket?.connect());

// ══ MESSAGE CACHE ═══════════════════════════════════════════════════════
function cacheMsg(msg) {
  const key = `${CACHE_KEY}_${msg.chat_id}`;
  const msgs = JSON.parse(localStorage.getItem(key) || "[]");
  const idx = msgs.findIndex(m => m.id === msg.id || (m.client_id && m.client_id === msg.client_id));
  if (idx >= 0) msgs[idx] = msg; else msgs.push(msg);
  if (msgs.length > 80) msgs.splice(0, msgs.length - 80);
  localStorage.setItem(key, JSON.stringify(msgs));
}
function getCache(chatId) { return JSON.parse(localStorage.getItem(`${CACHE_KEY}_${chatId}`) || "[]"); }

// ══ CHATS ═══════════════════════════════════════════════════════════════
function renderChatList() {
  const list = $("chatList"); list.innerHTML = "";
  S.chats.forEach(c => {
    const el = document.createElement("div");
    el.className = "chat-item" + (c.id === S.activeChat ? " active" : "");
    el.innerHTML = `
      <div class="avatar av40">${avatarHtml(c.avatar, c.name)}</div>
      <div class="chat-item-info">
        <div class="chat-item-name">${esc(c.name || "Чат")}</div>
        <div class="chat-item-preview">${esc(previewText(c))}</div>
      </div>
      <div class="chat-item-time">${c.last_time ? timeStr(c.last_time) : ""}</div>`;
    el.onclick = () => openChat(c.id);
    list.appendChild(el);
  });
}

function previewText(c) {
  if (!c.last_type) return "";
  if (c.last_type === "text") return c.last_content || "";
  return { image:"📷 Фото", video:"📹 Відео", voice:"🎤 Голосове", sticker:"🙂 Наліпка", file:"📎 Файл" }[c.last_type] || "";
}

function updateChatPreview(msg) {
  const chat = S.chats.find(c => c.id === msg.chat_id);
  if (chat) { chat.last_content = msg.content; chat.last_type = msg.type; chat.last_time = msg.created_at; renderChatList(); }
}

async function openChat(chatId, silent) {
  S.activeChat = chatId;
  localStorage.setItem("yc_lastchat", chatId);
  const chat = S.chats.find(c => c.id === chatId);

  // Mobile: show chat, hide sidebar
  if (window.innerWidth < 640) {
    $("sidebar").classList.remove("open");
  }

  $("noChatState").classList.add("hidden");
  $("chatView").classList.remove("hidden");

  // Header
  const hAv = $("chatHeaderAvatar");
  hAv.innerHTML = avatarHtml(chat?.avatar, chat?.name);
  $("chatHeaderName").textContent = chat?.name || "Чат";
  $("chatHeaderSub").textContent = chat?.type === "group" ? "Груповий чат" : "Особисте";

  // Join socket room
  socket?.emit("join-chat", chatId);

  // Render cache first (instant)
  const msgs = $("messages");
  msgs.innerHTML = "";
  getCache(chatId).forEach(m => appendMessage(m, true));
  scrollBottom();

  // Load from server
  try {
    const r = await apiFetch(`/api/chats/${chatId}/messages`);
    msgs.innerHTML = "";
    r.forEach(m => { cacheMsg(m); appendMessage(m, true); });
    scrollBottom();
  } catch {}

  // Pending queue for this chat
  getQueue().filter(m => m.chatId === chatId).forEach(m => appendMessage(m, false));
  renderChatList();
}

async function openNewGroupModal() {
  $("newGroupModal").classList.remove("hidden");
}
async function createGroupChat() {
  const name = $("groupName").value.trim();
  if (!name) return;
  const chat = await apiFetch("/api/chats", "POST", { name, type: "group" });
  if (chat.id) { S.chats.unshift(chat); renderChatList(); openChat(chat.id); closeModal("newGroupModal"); }
}

// User search → start private chat
async function onSearch(q) {
  const box = $("searchResults");
  if (!q.trim()) { box.classList.add("hidden"); return; }
  const users = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`).catch(() => []);
  if (!users.length) { box.classList.add("hidden"); return; }
  box.innerHTML = users.filter(u => u.id !== S.me.id).map(u => `
    <div class="search-result-item" onclick="startPrivateChat(${u.id},'${esc(u.display_name)}','${esc(u.avatar || "")}')">
      <div class="avatar av36">${avatarHtml(u.avatar, u.display_name)}</div>
      <div><div class="search-result-name">${esc(u.display_name)}</div><div class="search-result-user">@${esc(u.username)}</div></div>
    </div>`).join("");
  box.classList.remove("hidden");
}
async function startPrivateChat(userId, name, avatar) {
  $("searchResults").classList.add("hidden");
  $("searchInput").value = "";
  const chat = await apiFetch("/api/chats", "POST", { type: "private", userId });
  if (chat.id) {
    if (!S.chats.find(c => c.id === chat.id)) { chat.name = name; chat.avatar = avatar; S.chats.unshift(chat); }
    renderChatList(); openChat(chat.id);
  }
}

// ══ MESSAGES ═══════════════════════════════════════════════════════════
function appendMessage(m, confirmed = false) {
  const msgs = $("messages");
  if (!msgs) return;
  const isMe = (m.user_id === S.me?.id) || (m.username === S.me?.username);
  const div = document.createElement("div");
  div.className = `msg-row ${isMe ? "out" : "in"}${!confirmed ? " pending" : ""}`;
  div.dataset.cid = m.client_id || "";
  div.dataset.mid = m.id || "";

  const reactions = m.reactions || [];
  const timeFormatted = timeStr(m.created_at);
  const editedHtml = m.edited_at ? `<span class="msg-edited">ред.</span>` : "";
  const statusHtml = isMe ? `<span class="msg-status${confirmed ? " sent" : ""}">${confirmed ? "✓✓" : "🕓"}</span>` : "";
  const replyHtml = m.reply_to ? `<div class="reply-preview">↩ ${esc(m.reply_content || "Повідомлення")}</div>` : "";

  let bodyHtml = "";
  if (m.deleted_at) {
    bodyHtml = `<span class="msg-text" style="opacity:.5;font-style:italic">Повідомлення видалено</span>`;
  } else if (m.type === "text") {
    bodyHtml = `<span class="msg-text">${linkify(esc(m.content || ""))}</span>`;
  } else if (m.type === "image") {
    bodyHtml = `<img class="msg-media" src="${m.file_url}" loading="lazy" onclick="openMedia('${m.file_url}','image')"/>`;
  } else if (m.type === "video") {
    bodyHtml = `<video class="msg-media" src="${m.file_url}" controls preload="none"></video>`;
  } else if (m.type === "sticker") {
    bodyHtml = `<img class="msg-sticker" src="${m.file_url}" loading="lazy"/>`;
  } else if (m.type === "voice") {
    bodyHtml = buildVoiceHtml(m);
  } else if (m.type === "file") {
    const fname = m.content || "Файл";
    bodyHtml = `<a href="${m.file_url}" target="_blank" style="color:var(--accent2);display:flex;align-items:center;gap:6px">📎 ${esc(fname)}</a>`;
  }

  div.innerHTML = `
    ${!isMe ? `<div class="msg-av av32">${avatarHtml(m.avatar, m.display_name || m.username)}</div>` : ""}
    <div class="bubble${m.deleted_at ? " deleted" : ""}">
      ${!isMe ? `<div class="sender">${esc(m.display_name || m.username)}</div>` : ""}
      ${replyHtml}${bodyHtml}
      <div class="msg-reactions">${buildReactions(m.id, reactions)}</div>
      <div class="msg-meta">${editedHtml}<span class="msg-time">${timeFormatted}</span>${statusHtml}</div>
    </div>`;

  // Long press / right click for context menu
  div.addEventListener("contextmenu", e => { e.preventDefault(); showCtx(e, m); });
  let pressTimer;
  div.addEventListener("touchstart", () => { pressTimer = setTimeout(() => showCtx(null, m), 600); });
  div.addEventListener("touchend", () => clearTimeout(pressTimer));

  msgs.appendChild(div);
}

function buildVoiceHtml(m) {
  const dur = parseInt(m.content) || 0;
  const bars = Array.from({ length: 20 }, (_, i) =>
    `<span style="height:${4 + Math.random() * 16}px"></span>`).join("");
  const uid = "v" + (m.id || Math.random().toString(36).slice(2));
  return `<div class="voice-msg">
    <button class="voice-play-btn" onclick="playVoice('${m.file_url}','${uid}')">▶</button>
    <div class="voice-wave" id="${uid}">${bars}</div>
    <span style="font-size:11px;color:rgba(255,255,255,.5);min-width:28px">${dur}с</span>
    <audio id="aud_${uid}" src="${m.file_url}" preload="none" style="display:none"></audio>
  </div>`;
}

function playVoice(url, uid) {
  const aud = document.getElementById("aud_" + uid);
  const wave = document.getElementById(uid);
  const btn = wave?.previousElementSibling;
  if (!aud) return;
  if (aud.paused) { aud.play(); wave?.classList.add("playing"); if (btn) btn.textContent = "⏸"; }
  else { aud.pause(); wave?.classList.remove("playing"); if (btn) btn.textContent = "▶"; }
  aud.onended = () => { wave?.classList.remove("playing"); if (btn) btn.textContent = "▶"; };
}

function buildReactions(msgId, reactions) {
  if (!reactions?.length) return "";
  const grouped = {};
  reactions.forEach(r => {
    const emoji = r.emoji || r;
    grouped[emoji] = grouped[emoji] || [];
    grouped[emoji].push(r.user_id || r);
  });
  return Object.entries(grouped).map(([emoji, users]) => {
    const mine = users.includes(S.me?.id) ? " mine" : "";
    return `<span class="reaction-chip${mine}" onclick="sendReaction(${msgId},'${emoji}')">${emoji}<span class="reaction-count">${users.length}</span></span>`;
  }).join("");
}

function scrollBottom(force) {
  const el = $("messages");
  if (!el) return;
  const near = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
  if (near || force) el.scrollTop = el.scrollHeight;
}

// ══ SEND ════════════════════════════════════════════════════════════════
function sendText() {
  const text = $("msgInput").value.trim();
  if (!text) return;
  $("msgInput").value = ""; $("msgInput").style.height = "";
  queueSend({ type: "text", content: text });
  socket?.emit("typing", { chatId: S.activeChat, isTyping: false });
}
function onMsgInput(el) {
  el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 120) + "px";
  if (!socket?.connected) return;
  socket.emit("typing", { chatId: S.activeChat, isTyping: true });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit("typing", { chatId: S.activeChat, isTyping: false }), 1500);
}
function onMsgKey(e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } }

function queueSend(payload) {
  const clientId = "c" + Date.now() + Math.random().toString(36).slice(2);
  const msg = {
    clientId,
    chatId: S.activeChat || 1,
    username: S.me?.username,
    display_name: S.me?.display_name,
    avatar: S.me?.avatar || "",
    user_id: S.me?.id,
    created_at: new Date().toISOString(),
    ...payload,
  };
  if (S.replyTo) { msg.replyTo = S.replyTo.id; msg.reply_content = S.replyTo.content; cancelReply(); }
  appendMessage(msg, false);
  scrollBottom(true);
  cacheMsg({ ...msg, id: msg.clientId });
  if (socket?.connected) trySend(msg);
  else pushQueue(msg);
}

// ══ FILE UPLOAD ═════════════════════════════════════════════════════════
$("fileInput").addEventListener("change", async () => {
  const files = Array.from($("fileInput").files);
  $("fileInput").value = "";
  for (const file of files) await handleFileUpload(file);
});

async function handleFileUpload(file) {
  const net = getNetQuality();
  let blob = file, type = "file";

  if (file.type.startsWith("image/")) {
    type = "image";
    const settings = net === "bad" ? [640, .45] : net === "mid" ? [1024, .65] : [1920, .85];
    blob = await compressImage(file, settings[0], settings[1]);
  } else if (file.type.startsWith("video/")) {
    type = "video";
    // No client-side video compression (needs ffmpeg.wasm, too heavy for E-net)
    // Just upload original
  } else if (file.type.startsWith("audio/")) {
    type = "voice";
  }

  try {
    const fd = new FormData();
    fd.append("file", blob, file.name || "file");
    const r = await authFetch("/upload", { method: "POST", body: fd });
    const { url } = await r.json();
    queueSend({ type, file_url: url, content: file.name });
  } catch (e) { alert("Помилка завантаження файлу: " + e.message); }
}

function compressImage(file, maxDim, quality) {
  return new Promise(res => {
    const img = new Image(), reader = new FileReader();
    reader.onload = e => img.src = e.target.result;
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob(b => res(b), "image/jpeg", quality);
    };
    reader.readAsDataURL(file);
  });
}

function getNetQuality() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!c) return S.saveMode ? "bad" : "good";
  if (c.effectiveType === "slow-2g" || c.effectiveType === "2g" || S.saveMode) return "bad";
  if (c.effectiveType === "3g") return "mid";
  return "good";
}

// ══ VOICE RECORDING ═════════════════════════════════════════════════════
async function startRec(e) {
  if (e) e.preventDefault();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recChunks = [];
    mediaRec = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 24000 });
    mediaRec.ondataavailable = e => recChunks.push(e.data);
    mediaRec.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $("recBar").classList.add("hidden");
      clearInterval(recInterval);
      if (mediaRec._cancelled) return;
      const dur = Math.round((Date.now() - recStart) / 1000);
      if (dur < 1) return;
      const blob = new Blob(recChunks, { type: "audio/webm" });
      const fd = new FormData(); fd.append("file", blob, "voice.webm");
      const r = await authFetch("/upload", { method: "POST", body: fd });
      const { url } = await r.json();
      queueSend({ type: "voice", file_url: url, content: String(dur) });
    };
    mediaRec.start();
    recStart = Date.now();
    $("recBar").classList.remove("hidden");
    recInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recStart) / 1000);
      $("recTime").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 200);
  } catch { alert("Немає доступу до мікрофона"); }
}
function stopRec() { if (mediaRec?.state !== "inactive") mediaRec?.stop(); }
function cancelRec() { if (mediaRec) { mediaRec._cancelled = true; stopRec(); } }

// ══ REACTIONS ════════════════════════════════════════════════════════════
const REACTION_EMOJIS = ["👍","❤️","😂","😮","😢","🔥","🎉","👎","💀","🤔","💯","😍","🥰","⚡","🫡"];
function showReactionPicker(msgId, anchorEl) {
  const picker = $("reactionPicker");
  picker.querySelector(".reaction-emojis").innerHTML = REACTION_EMOJIS.map(e =>
    `<button onclick="sendReaction(${msgId},'${e}');closeReactionPicker()">${e}</button>`).join("");
  const rect = anchorEl?.getBoundingClientRect() || { top: 200, left: 100 };
  picker.style.top = Math.max(rect.top - 70, 10) + "px";
  picker.style.left = Math.min(rect.left, window.innerWidth - 280) + "px";
  picker.classList.remove("hidden");
  setTimeout(() => document.addEventListener("click", closeReactionPicker, { once: true }), 100);
}
function closeReactionPicker() { $("reactionPicker").classList.add("hidden"); }
function sendReaction(msgId, emoji) { socket?.emit("reaction", { messageId: msgId, emoji }); }

// ══ CONTEXT MENU ════════════════════════════════════════════════════════
function showCtx(e, msg) {
  S.ctxMsg = msg;
  const menu = $("ctxMenu");
  const isMe = msg.user_id === S.me?.id;
  menu.querySelector("button:nth-child(2)").style.display = isMe && !msg.deleted_at ? "" : "none";
  menu.querySelector("button:nth-child(3)").style.display = isMe && !msg.deleted_at ? "" : "none";
  const x = e ? Math.min(e.clientX, window.innerWidth - 180) : 100;
  const y = e ? Math.min(e.clientY, window.innerHeight - 180) : 100;
  menu.style.left = x + "px"; menu.style.top = y + "px";
  menu.classList.remove("hidden");
  setTimeout(() => document.addEventListener("click", () => menu.classList.add("hidden"), { once: true }), 50);
}
function ctxReply() {
  S.replyTo = S.ctxMsg;
  $("replyBar").classList.remove("hidden");
  $("replyText").textContent = (S.ctxMsg.content || "медіа").slice(0, 60);
  $("msgInput").focus();
}
function cancelReply() { S.replyTo = null; $("replyBar").classList.add("hidden"); }
function ctxEdit() {
  const msg = S.ctxMsg;
  if (!msg || msg.type !== "text") return;
  const newContent = prompt("Редагувати повідомлення:", msg.content);
  if (newContent !== null && newContent !== msg.content) socket?.emit("edit-message", { messageId: msg.id, content: newContent });
}
function ctxDelete() {
  if (!S.ctxMsg || !confirm("Видалити повідомлення?")) return;
  socket?.emit("delete-message", { messageId: S.ctxMsg.id });
}
function ctxReact() {
  const el = document.querySelector(`[data-mid="${S.ctxMsg?.id}"]`);
  showReactionPicker(S.ctxMsg?.id, el);
}

// ══ STICKERS ════════════════════════════════════════════════════════════
async function openStickers() {
  $("stickersModal").classList.remove("hidden");
  const packs = await apiFetch("/api/stickers").catch(() => []);
  const container = $("stickerPacks"); container.innerHTML = "";
  packs.forEach(pack => {
    const div = document.createElement("div");
    div.className = "sticker-pack";
    div.innerHTML = `<div class="sticker-pack-name">${esc(pack.pack_name)}</div>
      <div class="sticker-grid">${(pack.stickers || []).map(s =>
        `<img class="sticker-item" src="${s.url}" title="${s.emoji}" onclick="sendSticker('${s.url}');closeModal('stickersModal')"/>`
      ).join("")}</div>`;
    container.appendChild(div);
  });
  // Populate pack selector for adding stickers
  const sel = $("packSelect"); sel.innerHTML = packs.map(p => `<option value="${p.pack_id}">${esc(p.pack_name)}</option>`).join("");
  if (packs.length) $("packSelector").classList.remove("hidden");
}

function sendSticker(url) { queueSend({ type: "sticker", file_url: url }); }

async function createPack() {
  const name = $("newPackName").value.trim();
  if (!name) return;
  const pack = await apiFetch("/api/stickers/pack", "POST", { name });
  if (pack.id) { $("newPackName").value = ""; openStickers(); }
}
async function addSticker(input) {
  const packId = $("packSelect").value;
  if (!packId || !input.files[0]) return;
  const fd = new FormData(); fd.append("file", input.files[0]); fd.append("emoji", "⭐");
  await authFetch(`/api/stickers/pack/${packId}/add`, { method: "POST", body: fd });
  input.value = "";
  openStickers();
}

// ══ PROFILE ═════════════════════════════════════════════════════════════
function openProfile() {
  $("profileDisplayName").value = S.me?.display_name || "";
  $("profileBio").value = S.me?.bio || "";
  $("profileUsername").textContent = S.me?.username || "";
  const av = $("profileAvatar");
  av.innerHTML = avatarHtml(S.me?.avatar, S.me?.display_name);
  $("profileModal").classList.remove("hidden");
}
async function saveProfile() {
  const updated = await apiFetch("/api/me", "PUT", {
    displayName: $("profileDisplayName").value.trim(),
    bio: $("profileBio").value.trim(),
  });
  S.me = { ...S.me, ...updated };
  localStorage.setItem("yc_me", JSON.stringify(S.me));
  renderMyAvatar();
  closeModal("profileModal");
}
async function uploadProfileAvatar(input) {
  const file = input.files[0]; if (!file) return;
  const blob = await compressImage(file, 256, .8);
  const fd = new FormData(); fd.append("file", blob, "avatar.jpg");
  const r = await authFetch("/upload", { method: "POST", body: fd });
  const { url } = await r.json();
  await apiFetch("/api/me", "PUT", { avatar: url });
  S.me.avatar = url;
  localStorage.setItem("yc_me", JSON.stringify(S.me));
  $("profileAvatar").style.backgroundImage = `url(${url})`;
  $("profileAvatar").innerHTML = "";
  renderMyAvatar();
}

function renderMyAvatar() {
  const el = $("myAvatar");
  if (!el) return;
  el.innerHTML = avatarHtml(S.me?.avatar, S.me?.display_name);
}

// ══ MAP ══════════════════════════════════════════════════════════════════
function openMap() {
  $("mapModal").classList.remove("hidden");
  setTimeout(() => {
    if (!S.map) initMap();
    else { S.map.invalidateSize(); loadMapMarkers(); }
  }, 60);
}

function initMap() {
  S.map = L.map("mapContainer").setView([50.45, 30.52], 10);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OSM contributors", maxZoom: 19
  }).addTo(S.map);

  S.map.on("click", e => {
    if (!S.markerMode) return;
    const title = $("markerTitle").value || "Зустріч";
    const meetingTime = $("markerTime").value;
    const color = "#7c3aed";
    socket?.emit("map-marker", { chatId: S.activeChat, lat: e.latlng.lat, lng: e.latlng.lng, title, meetingTime, color });
    S.markerMode = false;
    $("addMarkerBtn").classList.remove("active");
  });

  loadMapMarkers();
}

async function loadMapMarkers() {
  if (!S.activeChat) return;
  const markers = await apiFetch(`/api/map/${S.activeChat}`).catch(() => []);
  markers.forEach(m => addMapMarker(m));
  renderMarkerList(markers);
}

function addMapMarker(m) {
  const icon = L.divIcon({
    html: `<div style="background:${m.color || "#7c3aed"};width:14px;height:14px;border-radius:50%;border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.4)"></div>`,
    className: "", iconSize: [14, 14]
  });
  const marker = L.marker([m.lat, m.lng], { icon })
    .addTo(S.map)
    .bindPopup(`<b>${m.title || "Зустріч"}</b>${m.meeting_time ? "<br>🕐 " + new Date(m.meeting_time).toLocaleString("uk-UA") : ""}<br><small>${m.display_name || ""}</small>`);
  S.mapMarkers[m.id] = marker;
}

function renderMarkerList(markers) {
  const list = $("mapMarkerList"); list.innerHTML = "";
  markers.forEach(m => {
    const div = document.createElement("div");
    div.className = "map-marker-item";
    div.innerHTML = `<span>📍 ${esc(m.title || "Зустріч")} ${m.meeting_time ? "· " + new Date(m.meeting_time).toLocaleTimeString("uk-UA",{hour:"2-digit",minute:"2-digit"}) : ""}</span>
      <button onclick="deleteMarker(${m.id})">✕</button>`;
    list.appendChild(div);
  });
}

function enableMarkerAdd() {
  S.markerMode = !S.markerMode;
  $("addMarkerBtn").classList.toggle("active", S.markerMode);
}
function deleteMarker(id) {
  socket?.emit("map-marker-delete", { chatId: S.activeChat, markerId: id });
}

let drawLayer = null;
function toggleDraw() {
  S.drawMode = !S.drawMode;
  $("drawBtn").classList.toggle("active", S.drawMode);
  if (!S.drawMode) { if (drawLayer) { S.map.removeLayer(drawLayer); drawLayer = null; } return; }
  // Simple freehand draw via mouse drag
  let isDrawing = false, points = [];
  S.map.on("mousedown", () => { isDrawing = true; points = []; });
  S.map.on("mousemove", e => {
    if (!isDrawing || !S.drawMode) return;
    points.push([e.latlng.lat, e.latlng.lng]);
    if (drawLayer) S.map.removeLayer(drawLayer);
    drawLayer = L.polyline(points, { color: "#7c3aed", weight: 3 }).addTo(S.map);
  });
  S.map.on("mouseup", () => {
    isDrawing = false;
    if (points.length > 1) socket?.emit("map-draw", { chatId: S.activeChat, paths: points });
  });
}
function renderMapDraw(paths) {
  L.polyline(paths, { color: "#2ea6ff", weight: 2, opacity: .7 }).addTo(S.map);
}

// ══ PUSH NOTIFICATIONS ══════════════════════════════════════════════════
async function setupPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const { publicKey } = await apiFetch("/api/push/key");
    if (!publicKey) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await apiFetch("/api/push/subscribe", "POST", { subscription: sub.toJSON() });
  } catch {}
}
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// ══ UI HELPERS ═══════════════════════════════════════════════════════════
function openMedia(url, type) {
  const w = window.open(); w.document.write(`<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;height:100vh"><${type === "image" ? "img" : "video controls"} src="${url}" style="max-width:100%;max-height:100vh"></${type === "image" ? "img" : "video"}></body>`);
}
function openChatInfo() {
  const c = S.chats.find(c => c.id === S.activeChat);
  if (c?.type === "group") $("newGroupModal").classList.remove("hidden");
}
function closeChatMobile() {
  $("chatView").classList.add("hidden");
  $("noChatState").classList.remove("hidden");
  if (window.innerWidth < 640) $("sidebar").classList.add("open");
}
function closeModal(id) { $(id).classList.add("hidden"); }
function toggleSaveMode() {
  S.saveMode = !S.saveMode;
  localStorage.setItem("yc_save", S.saveMode ? "1" : "0");
  $("saveModeBtn").classList.toggle("active", S.saveMode);
}
function avatarHtml(url, name) {
  if (url) return `<span style="display:block;width:100%;height:100%;background:url(${url}) center/cover;border-radius:50%"></span>`;
  const ch = (name || "?").trim()[0]?.toUpperCase() || "?";
  return `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;font-size:inherit">${ch}</span>`;
}
function esc(str) {
  const d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML;
}
function linkify(text) {
  return text.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank">$1</a>');
}
function timeStr(ts) {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString("uk-UA", { day: "2-digit", month: "2-digit" });
}

// ══ API FETCH ════════════════════════════════════════════════════════════
async function apiFetch(url, method = "GET", body) {
  const opts = { method, headers: { Authorization: `Bearer ${S.token}` } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(r.statusText);
  return r.json();
}
async function authFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${S.token}` };
  return fetch(url, opts);
}

// ══ MOBILE SIDEBAR ═══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  if (window.innerWidth < 640) {
    $("sidebar").classList.add("open");
  }
});

