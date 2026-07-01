/* ══ YARCHAT CLIENT v5 ═══════════════════════════════════════════════
   Auth · Multiple chats · EDGE-adaptive media compression · Stickers
   Map (Leaflet) · Push notifications · Reactions with animations
══════════════════════════════════════════════════════════════════════ */

// ─── State ───────────────────────────────────────────────────────────
const state = {
  token: localStorage.getItem("yc_token") || "",
  me: JSON.parse(localStorage.getItem("yc_me") || "null"),
  currentChat: null,
  chats: [],
  saveMode: localStorage.getItem("yc_save") === "1",
  replyTo: null,
  oldestMsgId: null,
  mapMode: "pan",      // pan | pin | draw
  mapColor: "#8b5cf6",
  leafletMap: null,
  leafletPins: {},
  leafletPolylines: [],
  drawPoints: [],
  isDrawing: false,
  stickerPendingUrl: "",
  mediaRecorder: null,
  recordChunks: [],
  recordStart: 0,
  recordTimer: null,
};

// ─── API helper ──────────────────────────────────────────────────────
async function api(method, url, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${state.token}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || "Error");
  return data;
}

// ─── Utils ───────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function esc(str) {
  const d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML;
}
function fmt(t) { return t ? new Date(t).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" }) : ""; }
function fmtDate(t) {
  if (!t) return "";
  const d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Сьогодні";
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Вчора";
  return d.toLocaleDateString("uk-UA", { day: "numeric", month: "long" });
}
function initials(name) { return (name || "?").trim()[0]?.toUpperCase() || "?"; }
function avatarEl(el, avatar, name) {
  if (avatar) { el.style.backgroundImage = `url(${avatar})`; el.textContent = ""; }
  else { el.style.backgroundImage = ""; el.textContent = initials(name); }
}
function toast(msg, ms = 2200) {
  const t = $("toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), ms);
}
function fmtSize(b) {
  if (!b) return "";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Connection quality / EDGE detection ─────────────────────────────
function connType() {
  const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  return c?.effectiveType || "4g";
}
function compressionSettings() {
  const t = connType();
  const map = {
    "slow-2g": { maxDim: 480, q: 0.32, voiceBr: 10000 },
    "2g":      { maxDim: 640, q: 0.42, voiceBr: 14000 },
    "3g":      { maxDim: 960, q: 0.60, voiceBr: 24000 },
    "4g":      { maxDim: 1280, q: 0.76, voiceBr: 32000 },
  };
  const s = state.saveMode
    ? { maxDim: 480, q: 0.30, voiceBr: 10000 }
    : (map[t] || map["4g"]);
  return s;
}

// ─── Media compression (client-side, before any upload) ───────────────
function compressImage(file, maxDim, quality) {
  return new Promise(resolve => {
    const img = new Image(), reader = new FileReader();
    reader.onload = e => (img.src = e.target.result);
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      c.toBlob(blob => resolve(blob), "image/jpeg", quality);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadBlob(blob, filename) {
  const fd = new FormData(); fd.append("file", blob, filename);
  const r = await fetch("/upload", {
    method: "POST",
    headers: { "Authorization": `Bearer ${state.token}` },
    body: fd,
  });
  return r.json(); // {url, name, size}
}

async function prepareFile(file) {
  const s = compressionSettings();
  if (file.type.startsWith("image/")) {
    toast("📸 Стискаю зображення...", 3000);
    const blob = await compressImage(file, s.maxDim, s.q);
    const r = await uploadBlob(blob, "photo.jpg");
    return { type: "image", fileUrl: r.url, fileName: "photo.jpg", fileSize: blob.size };
  }
  if (file.type.startsWith("video/")) {
    toast("🎬 Завантажую відео...", 60000);
    const r = await uploadBlob(file, file.name);
    toast("✅ Відео надіслано");
    return { type: "video", fileUrl: r.url, fileName: file.name, fileSize: file.size };
  }
  // Any other file
  toast("📎 Завантажую файл...", 10000);
  const r = await uploadBlob(file, file.name);
  toast("✅ Файл надіслано");
  return { type: "file", fileUrl: r.url, fileName: file.name, fileSize: file.size };
}

// ─── Auth ─────────────────────────────────────────────────────────────
function showAuth() {
  $("authScreen").classList.remove("hidden");
  $("appScreen").classList.add("hidden");
}
function showApp() {
  $("authScreen").classList.add("hidden");
  $("appScreen").classList.remove("hidden");
  updateMeSidebar();
  initSocket();
  registerSW();
  loadChats();
}

document.querySelectorAll(".auth-tab").forEach(tab => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".auth-tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    $("tabLogin").classList.add("hidden");
    $("tabRegister").classList.add("hidden");
    $(`tab${tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1)}`).classList.remove("hidden");
  });
});

$("loginBtn").addEventListener("click", async () => {
  $("loginError").textContent = "";
  try {
    const d = await api("POST", "/api/login", {
      username: $("loginUsername").value.trim(),
      password: $("loginPassword").value,
    });
    saveAuth(d);
    showApp();
  } catch (e) { $("loginError").textContent = e.message; }
});
$("loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") $("loginBtn").click(); });

$("registerBtn").addEventListener("click", async () => {
  $("regError").textContent = "";
  try {
    const d = await api("POST", "/api/register", {
      username: $("regUsername").value.trim(),
      password: $("regPassword").value,
      display_name: $("regDisplayName").value.trim() || $("regUsername").value.trim(),
    });
    saveAuth(d);
    showApp();
  } catch (e) { $("regError").textContent = e.message; }
});

function saveAuth({ token, user }) {
  state.token = token; state.me = user;
  localStorage.setItem("yc_token", token);
  localStorage.setItem("yc_me", JSON.stringify(user));
}

function updateMeSidebar() {
  const u = state.me; if (!u) return;
  $("meName").textContent = u.display_name || u.username;
  $("meUsername").textContent = "@" + u.username;
  avatarEl($("meAvatar"), u.avatar, u.display_name || u.username);
}

// ─── Socket.IO ────────────────────────────────────────────────────────
let socket;
let typingTimeout = null;
const activeTypers = {};

function initSocket() {
  socket = io({ auth: { token: state.token }, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });

  socket.on("connect", () => {
    startPing();
    flushOfflineQueue();
  });
  socket.on("disconnect", () => setConn("bad"));

  socket.on("message", onMessage);
  socket.on("message:updated", onMsgUpdated);
  socket.on("message:deleted", onMsgDeleted);
  socket.on("reaction-update", onReactionUpdate);
  socket.on("presence", onPresence);
  socket.on("typing", onTyping);
  socket.on("map:pin", onMapPin);
  socket.on("map:drawn", onMapDrawn);
  socket.on("map:pin-deleted", onMapPinDeleted);
  socket.on("map:cleared", onMapCleared);
}

// ─── Offline queue ────────────────────────────────────────────────────
const QKEY = "yc_msgq";
function getQ() { return JSON.parse(localStorage.getItem(QKEY) || "[]"); }
function setQ(q) { localStorage.setItem(QKEY, JSON.stringify(q)); }
function enqueue(msg) { const q = getQ(); q.push(msg); setQ(q); }
function dequeue(clientId) { setQ(getQ().filter(m => m.clientId !== clientId)); }
function flushOfflineQueue() {
  getQ().forEach(msg => emitMessage(msg));
}

function emitMessage(msg) {
  if (!socket?.connected) { enqueue(msg); return; }
  socket.emit("message", msg, ack => {
    if (ack?.ok) {
      dequeue(msg.clientId);
      updateMsgStatus(msg.clientId, msg.chatId, ack.id, "✓✓");
    } else {
      enqueue(msg);
    }
  });
}

function sendMsg(payload) {
  const clientId = "c" + Date.now() + Math.random().toString(36).slice(2, 6);
  const msg = {
    clientId,
    chatId: state.currentChat.id,
    username: state.me.username,
    avatar: state.me.avatar,
    createdAt: new Date().toISOString(),
    reactions: {},
    ...payload,
  };
  renderMessage(msg, false);
  scrollBottom();
  emitMessage(msg);
  updateChatPreview(msg);
}

// ─── Chats ────────────────────────────────────────────────────────────
async function loadChats() {
  try {
    state.chats = await api("GET", "/api/chats");
    renderChatList();
  } catch {}
}

function renderChatList(chats) {
  const list = chats || state.chats;
  const cl = $("chatList"); cl.innerHTML = "";
  list.forEach(c => {
    const div = document.createElement("div");
    div.className = "chat-item" + (state.currentChat?.id === c.id ? " active" : "");
    div.dataset.id = c.id;
    const avatar = c.avatar || (c.type === "dm" ? c.partner?.avatar : "");
    const name = c.name || (c.type === "dm" ? (c.partner?.display_name || c.partner?.username) : "Чат");
    const preview = previewText(c.last_message);
    const time = c.last_message ? fmt(c.last_message.created_at) : "";
    div.innerHTML = `
      <div class="chat-item-avatar" style="${avatar ? `background-image:url(${avatar});` : ""}">${avatar ? "" : initials(name)}</div>
      <div class="chat-item-body">
        <div class="chat-item-name">${esc(name)}</div>
        <div class="chat-item-preview">${esc(preview)}</div>
      </div>
      <div class="chat-item-meta">
        <div class="chat-item-time">${time}</div>
      </div>
    `;
    div.addEventListener("click", () => openChat(c));
    cl.appendChild(div);
  });
}

function previewText(m) {
  if (!m) return "";
  if (m.type === "text") return m.content?.slice(0, 40) || "";
  if (m.type === "image") return "📸 Фото";
  if (m.type === "video") return "🎬 Відео";
  if (m.type === "voice") return "🎤 Голосове";
  if (m.type === "sticker") return "🧡 Стікер";
  if (m.type === "file") return `📎 ${m.file_name || "Файл"}`;
  return "";
}

function updateChatPreview(msg) {
  const chat = state.chats.find(c => c.id === msg.chatId);
  if (chat) { chat.last_message = { ...msg, created_at: msg.createdAt }; renderChatList(); }
}

async function openChat(chat) {
  state.currentChat = chat;
  state.oldestMsgId = null;
  state.replyTo = null;
  $("replyPreview").classList.add("hidden");

  // Render header
  const name = chat.name || (chat.type === "dm" ? (chat.partner?.display_name || chat.partner?.username) : "Чат");
  const avatar = chat.avatar || (chat.type === "dm" ? chat.partner?.avatar : "");
  $("chatHeaderName").textContent = name;
  avatarEl($("chatHeaderAvatar"), avatar, name);
  $("chatHeaderSub").textContent = chat.type === "group" ? "Групповий чат" : "Приватний чат";

  // Show on mobile
  $("sidebar").classList.add("hidden-mobile");
  $("chatView").classList.remove("hidden");
  $("emptyState").classList.add("hidden");

  // Mark active
  document.querySelectorAll(".chat-item").forEach(el => el.classList.remove("active"));
  document.querySelector(`.chat-item[data-id="${chat.id}"]`)?.classList.add("active");

  // Load messages
  $("messages").innerHTML = "";
  socket?.emit("chat:join", chat.id);
  await loadHistory(chat.id);
}

async function loadHistory(chatId, before) {
  try {
    const url = `/api/chats/${chatId}/messages${before ? "?before=" + before : ""}`;
    const msgs = await api("GET", url);
    if (!msgs.length) { $("loadMoreWrap").classList.add("hidden"); return; }
    if (before) {
      const firstEl = $("messages").firstChild;
      msgs.forEach(m => { $("messages").insertBefore(buildMsgEl(m, true), $("messages").firstChild); });
      firstEl?.scrollIntoView();
    } else {
      msgs.forEach(m => renderMessage(m, true));
      scrollBottom();
    }
    state.oldestMsgId = msgs[0]?.id;
    $("loadMoreWrap").classList.toggle("hidden", msgs.length < 50);
    // Render pending offline queue for this chat
    getQ().filter(m => m.chatId === chatId).forEach(m => renderMessage(m, false));
  } catch {}
}

$("loadMoreBtn").addEventListener("click", () => {
  if (state.currentChat && state.oldestMsgId) loadHistory(state.currentChat.id, state.oldestMsgId);
});
$("backBtn").addEventListener("click", () => {
  $("sidebar").classList.remove("hidden-mobile");
  $("chatView").classList.add("hidden");
  $("emptyState").classList.remove("hidden");
  state.currentChat = null;
  document.querySelectorAll(".chat-item").forEach(el => el.classList.remove("active"));
});

// ─── Send text ────────────────────────────────────────────────────────
$("sendBtn").addEventListener("click", sendTextMsg);
$("msgInput").addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendTextMsg(); }
});
$("msgInput").addEventListener("input", () => {
  if (!state.currentChat || !socket?.connected) return;
  socket.emit("typing", { chatId: state.currentChat.id, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => socket.emit("typing", { chatId: state.currentChat.id, isTyping: false }), 1400);
});

function sendTextMsg() {
  const input = $("msgInput");
  const text = input.textContent.trim();
  if (!text || !state.currentChat) return;
  input.textContent = "";
  sendMsg({
    type: "text",
    content: text,
    replyTo: state.replyTo?.id || null,
    replyToUsername: state.replyTo?.username,
    replyToContent: state.replyTo?.content,
  });
  state.replyTo = null;
  $("replyPreview").classList.add("hidden");
}

// ─── File attach ──────────────────────────────────────────────────────
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", async () => {
  const files = Array.from($("fileInput").files);
  $("fileInput").value = "";
  if (!files.length || !state.currentChat) return;
  for (const file of files) {
    try {
      const payload = await prepareFile(file);
      sendMsg({ ...payload, replyTo: state.replyTo?.id || null });
      state.replyTo = null; $("replyPreview").classList.add("hidden");
    } catch (e) { toast("❌ Помилка: " + e.message); }
  }
});

// ─── Voice ────────────────────────────────────────────────────────────
$("micBtn").addEventListener("mousedown", startRec);
$("micBtn").addEventListener("touchstart", e => { e.preventDefault(); startRec(); });
$("micBtn").addEventListener("mouseup", stopRec);
$("micBtn").addEventListener("touchend", e => { e.preventDefault(); stopRec(); });
$("cancelRecBtn").addEventListener("click", () => {
  if (state.mediaRecorder?.state !== "inactive") { state.mediaRecorder.cancelled = true; state.mediaRecorder.stop(); }
});

async function startRec() {
  try {
    const s = compressionSettings();
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordChunks = [];
    state.mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: s.voiceBr });
    state.mediaRecorder.ondataavailable = e => state.recordChunks.push(e.data);
    state.mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      $("recordingBar").classList.add("hidden");
      clearInterval(state.recordTimer);
      if (state.mediaRecorder.cancelled) return;
      const dur = Math.round((Date.now() - state.recordStart) / 1000);
      if (dur < 1) { toast("Голосове занадто коротке"); return; }
      const blob = new Blob(state.recordChunks, { type: "audio/webm" });
      toast("🎤 Надсилаю голосове...", 5000);
      const r = await uploadBlob(blob, "voice.webm");
      sendMsg({ type: "voice", fileUrl: r.url, content: String(dur) });
    };
    state.mediaRecorder.start();
    state.recordStart = Date.now();
    $("recordingBar").classList.remove("hidden");
    state.recordTimer = setInterval(() => {
      const s = Math.floor((Date.now() - state.recordStart) / 1000);
      $("recTimer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 200);
  } catch { toast("❌ Немає доступу до мікрофона"); }
}
function stopRec() {
  if (state.mediaRecorder?.state !== "inactive") state.mediaRecorder.stop();
}

// ─── Stickers ─────────────────────────────────────────────────────────
$("stickerBtn").addEventListener("click", async () => {
  openModal("stickerModal");
  await loadStickers();
});
async function loadStickers() {
  try {
    const stickers = await api("GET", "/api/stickers");
    const grid = $("stickerGrid"); grid.innerHTML = "";
    stickers.forEach(s => {
      const item = document.createElement("div"); item.className = "sticker-item";
      const img = document.createElement("img"); img.src = s.image_url; img.alt = s.name || "";
      item.appendChild(img);
      item.addEventListener("click", () => {
        if (!state.currentChat) return;
        sendMsg({ type: "sticker", fileUrl: s.image_url, content: s.name || "" });
        closeModals();
      });
      grid.appendChild(item);
    });
  } catch {}
}

$("stickerImageInput").addEventListener("change", async () => {
  const file = $("stickerImageInput").files[0]; if (!file) return;
  const blob = await compressImage(file, 256, 0.85);
  const r = await uploadBlob(blob, "sticker.png");
  state.stickerPendingUrl = r.url;
  const prev = $("stickerPreview"); prev.style.display = "block";
  prev.innerHTML = `<img src="${r.url}" alt=""/>`;
  toast("Зображення завантажено");
});

$("addStickerBtn").addEventListener("click", async () => {
  if (!state.stickerPendingUrl) { toast("Спочатку вибери зображення"); return; }
  try {
    await api("POST", "/api/stickers", { name: $("stickerName").value || "Стікер", image_url: state.stickerPendingUrl });
    state.stickerPendingUrl = ""; $("stickerPreview").style.display = "none"; $("stickerName").value = "";
    toast("✅ Стікер додано!"); await loadStickers();
  } catch (e) { toast("❌ " + e.message); }
});

// ─── Map ──────────────────────────────────────────────────────────────
$("mapBtn").addEventListener("click", openMap);

function openMap() {
  if (!state.currentChat) return;
  openModal("mapModal");
  setTimeout(initMap, 100);
}

function initMap() {
  if (state.leafletMap) { state.leafletMap.invalidateSize(); loadMapData(); return; }
  state.leafletMap = L.map("leafletMap", { center: [50.45, 30.52], zoom: 12 });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    attribution: "© OpenStreetMap, © CARTO", maxZoom: 19
  }).addTo(state.leafletMap);

  state.leafletMap.on("click", onMapClick);
  state.leafletMap.on("mousemove", onMapMouseMove);
  state.leafletMap.on("mousedown", onMapMouseDown);
  state.leafletMap.on("mouseup", onMapMouseUp);
  loadMapData();
}

async function loadMapData() {
  if (!state.currentChat) return;
  try {
    const data = await api("GET", `/api/chats/${state.currentChat.id}/map`);
    data.pins.forEach(p => addMapPin(p, false));
    data.drawings.forEach(d => addMapDrawing(d, false));
  } catch {}
}

function onMapClick(e) {
  if (state.mapMode !== "pin") return;
  const { lat, lng } = e.latlng;
  $("pinForm").classList.remove("hidden");
  $("pinSaveBtn").onclick = () => {
    const title = $("pinTitle").value.trim(); const desc = $("pinDesc").value.trim();
    const meet_time = $("pinTime").value;
    socket?.emit("map:pin-add", { chatId: state.currentChat.id, lat, lng, title, description: desc, meet_time, color: state.mapColor });
    $("pinForm").classList.add("hidden");
    $("pinTitle").value = ""; $("pinDesc").value = ""; $("pinTime").value = "";
  };
}
$("pinCancelBtn").addEventListener("click", () => $("pinForm").classList.add("hidden"));

let drawPath = [];
function onMapMouseDown(e) {
  if (state.mapMode !== "draw") return;
  state.isDrawing = true; drawPath = [[e.latlng.lat, e.latlng.lng]];
}
function onMapMouseMove(e) {
  if (!state.isDrawing) return;
  drawPath.push([e.latlng.lat, e.latlng.lng]);
  if (state._previewLine) state.leafletMap.removeLayer(state._previewLine);
  state._previewLine = L.polyline(drawPath, { color: state.mapColor, weight: 3, opacity: .7 }).addTo(state.leafletMap);
}
function onMapMouseUp() {
  if (!state.isDrawing || drawPath.length < 2) { state.isDrawing = false; drawPath = []; return; }
  state.isDrawing = false;
  if (state._previewLine) { state.leafletMap.removeLayer(state._previewLine); state._previewLine = null; }
  socket?.emit("map:draw", { chatId: state.currentChat.id, points: drawPath, color: state.mapColor, width: 3 });
  drawPath = [];
}

["mapModePan", "mapModePin", "mapModeDraw"].forEach(id => {
  $(id).addEventListener("click", () => {
    state.mapMode = { mapModePan: "pan", mapModePin: "pin", mapModeDraw: "draw" }[id];
    document.querySelectorAll(".map-tool-btn").forEach(b => b.classList.remove("active"));
    $(id).classList.add("active");
    state.leafletMap?.[state.mapMode === "pan" ? "dragging" : ""][state.mapMode === "pan" ? "enable" : "disable"]?.();
  });
});

$("mapColor").addEventListener("input", e => { state.mapColor = e.target.value; });
$("mapClearDrawings").addEventListener("click", () => {
  if (!state.currentChat) return;
  if (!confirm("Очистити всі малюнки на карті?")) return;
  socket?.emit("map:clear-drawings", { chatId: state.currentChat.id });
});

function addMapPin(pin, animate) {
  const icon = L.divIcon({
    className: "",
    html: `<div style="background:${pin.color||"#8b5cf6"};width:20px;height:20px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid white;box-shadow:0 2px 8px rgba(0,0,0,.5)"></div>`,
    iconSize: [20, 20], iconAnchor: [10, 20],
  });
  const popup = `<b style="color:#f0eeff">${pin.title||"Мітка"}</b><br/><span style="color:#8b8fa8">${pin.description||""}</span>${pin.meet_time ? `<br/>🕐 ${new Date(pin.meet_time).toLocaleString("uk-UA")}` : ""}${pin.username ? `<br/><small>📌 ${pin.username}</small>` : ""}
  <br/><button onclick="deletePin(${pin.id})" style="margin-top:4px;padding:2px 8px;border-radius:6px;background:#ef444420;border:1px solid #ef444440;color:#ef4444;cursor:pointer;font-size:12px">Видалити</button>`;
  const marker = L.marker([pin.lat, pin.lng], { icon }).addTo(state.leafletMap).bindPopup(popup);
  state.leafletPins[pin.id] = marker;
}
window.deletePin = function(id) {
  if (!state.currentChat) return;
  socket?.emit("map:pin-delete", { chatId: state.currentChat.id, pinId: id });
};
function addMapDrawing(drawing, animate) {
  const points = Array.isArray(drawing.points) ? drawing.points : JSON.parse(drawing.points || "[]");
  const line = L.polyline(points, { color: drawing.color || "#8b5cf6", weight: drawing.width || 3 }).addTo(state.leafletMap);
  state.leafletPolylines.push({ id: drawing.id, line });
}

function onMapPin(pin) {
  if (pin.chat_id !== state.currentChat?.id) return;
  addMapPin(pin, true);
}
function onMapDrawn(drawing) {
  if (drawing.chat_id !== state.currentChat?.id) return;
  addMapDrawing(drawing, true);
}
function onMapPinDeleted({ pinId }) {
  const m = state.leafletPins[pinId];
  if (m) { state.leafletMap?.removeLayer(m); delete state.leafletPins[pinId]; }
}
function onMapCleared() {
  state.leafletPolylines.forEach(d => state.leafletMap?.removeLayer(d.line));
  state.leafletPolylines = [];
}

// ─── Save mode ────────────────────────────────────────────────────────
$("saveModeBtn").addEventListener("click", () => {
  state.saveMode = !state.saveMode;
  localStorage.setItem("yc_save", state.saveMode ? "1" : "0");
  $("saveModeBtn").classList.toggle("active", state.saveMode);
  toast(state.saveMode ? "🐢 Режим економії трафіку увімкнено" : "⚡ Стандартний режим");
});
if (state.saveMode) $("saveModeBtn")?.classList.add("active");

// ─── Reactions ────────────────────────────────────────────────────────
const picker = $("reactionPicker");
let pickerMsgId = null, pickerChatId = null;

document.querySelectorAll(".emoji-opt").forEach(el => {
  el.addEventListener("click", () => {
    if (!pickerMsgId) return;
    socket?.emit("reaction", { messageId: pickerMsgId, chatId: pickerChatId, emoji: el.dataset.e });
    picker.classList.remove("visible");
  });
});
document.addEventListener("click", e => {
  if (!picker.contains(e.target) && !e.target.closest(".bubble")) picker.classList.remove("visible");
});

function showReactionPicker(msgId, chatId, el) {
  pickerMsgId = msgId; pickerChatId = chatId;
  const rect = el.getBoundingClientRect();
  picker.style.left = Math.min(rect.left, window.innerWidth - 280) + "px";
  picker.style.top = (rect.top - 60) + "px";
  picker.classList.add("visible");
}

function onReactionUpdate({ messageId, chatId, reactions }) {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"]`);
  if (!bubble) return;
  const row = bubble.querySelector(".reactions-row");
  if (row) row.innerHTML = buildReactions(reactions, messageId, chatId);
}

function buildReactions(reactions, msgId, chatId) {
  if (!reactions) return "";
  return Object.entries(reactions)
    .filter(([, users]) => users.length)
    .map(([emoji, users]) => {
      const mine = users.includes(state.me?.username);
      return `<span class="reaction-chip${mine ? " mine" : ""}" data-mid="${msgId}" data-cid="${chatId}" data-e="${emoji}">${emoji} <span class="count">${users.length}</span></span>`;
    }).join("");
}

$("messages").addEventListener("click", e => {
  const chip = e.target.closest(".reaction-chip");
  if (chip) {
    chip.classList.add("pop");
    setTimeout(() => chip.classList.remove("pop"), 300);
    socket?.emit("reaction", { messageId: +chip.dataset.mid, chatId: +chip.dataset.cid, emoji: chip.dataset.e });
  }
});

// ─── Edit / delete context menu ───────────────────────────────────────
$("messages").addEventListener("contextmenu", e => {
  e.preventDefault();
  const bubble = e.target.closest(".bubble");
  if (!bubble) return;
  const msgId = +bubble.closest("[data-msg-id]")?.dataset.msgId;
  const chatId = state.currentChat?.id;
  if (!msgId) return;

  const isOwn = bubble.closest("[data-is-own]");
  showCtxMenu(e.clientX, e.clientY, msgId, chatId, !!isOwn, bubble);
});
$("messages").addEventListener("touchstart", (() => {
  let t;
  return e => {
    const bubble = e.target.closest(".bubble"); if (!bubble) return;
    t = setTimeout(() => {
      const msgId = +bubble.closest("[data-msg-id]")?.dataset.msgId;
      const chatId = state.currentChat?.id;
      if (!msgId) return;
      showCtxMenu(window.innerWidth / 2 - 60, window.innerHeight / 2, msgId, chatId, !!bubble.closest("[data-is-own]"), bubble);
    }, 600);
    e.target.addEventListener("touchend", () => clearTimeout(t), { once: true });
  };
})(), { passive: true });

function showCtxMenu(x, y, msgId, chatId, isOwn, bubbleEl) {
  removeCtxMenu();
  const menu = document.createElement("div");
  menu.id = "ctxMenu";
  Object.assign(menu.style, {
    position: "fixed", left: Math.min(x, window.innerWidth - 180) + "px", top: Math.min(y, window.innerHeight - 160) + "px",
    background: "rgba(15,17,34,.97)", border: "1px solid rgba(255,255,255,.1)", borderRadius: "14px",
    padding: "6px", zIndex: "300", backdropFilter: "blur(16px)", minWidth: "160px",
    boxShadow: "0 16px 40px rgba(0,0,0,.5)",
  });
  const btn = (label, action) => {
    const b = document.createElement("button");
    Object.assign(b.style, { display: "block", width: "100%", padding: "9px 14px", border: "none", background: "none", color: "#f0eeff", fontSize: "14px", textAlign: "left", cursor: "pointer", borderRadius: "8px" });
    b.textContent = label; b.addEventListener("mouseenter", () => b.style.background = "rgba(255,255,255,.06)");
    b.addEventListener("mouseleave", () => b.style.background = "none");
    b.addEventListener("click", () => { action(); removeCtxMenu(); }); return b;
  };

  menu.appendChild(btn("😀 Реакція", () => showReactionPicker(msgId, chatId, bubbleEl)));
  menu.appendChild(btn("↩ Відповісти", () => setReply(msgId, chatId)));
  if (isOwn) {
    menu.appendChild(btn("✏️ Редагувати", () => editMsg(msgId, chatId, bubbleEl)));
    const del = btn("🗑 Видалити", () => {
      socket?.emit("message:delete", { messageId: msgId, chatId });
    });
    del.style.color = "#ef4444"; menu.appendChild(del);
  }
  document.body.appendChild(menu);
  document.addEventListener("click", removeCtxMenu, { once: true });
}
function removeCtxMenu() { document.getElementById("ctxMenu")?.remove(); }

function setReply(msgId, chatId) {
  const bubble = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (!bubble) return;
  const text = bubble.querySelector(".text")?.textContent || "...";
  const name = bubble.querySelector(".sender")?.textContent || state.me?.username;
  state.replyTo = { id: msgId, username: name, content: text };
  $("replyName").textContent = name; $("replyText").textContent = text;
  $("replyPreview").classList.remove("hidden");
  $("msgInput").focus();
}
$("replyClose").addEventListener("click", () => { state.replyTo = null; $("replyPreview").classList.add("hidden"); });

function editMsg(msgId, chatId, bubbleEl) {
  const textEl = bubbleEl.querySelector(".text"); if (!textEl) return;
  const old = textEl.textContent;
  const newVal = prompt("Редагувати повідомлення:", old);
  if (!newVal || newVal === old) return;
  socket?.emit("message:edit", { messageId: msgId, chatId, content: newVal });
}

// ─── Message rendering ────────────────────────────────────────────────
let lastMsgDate = "", lastSenderId = null;

function renderMessage(m, confirmed) {
  const existing = document.querySelector(`[data-client-id="${m.clientId}"]`);
  if (existing) return;
  const el = buildMsgEl(m, confirmed);
  $("messages").appendChild(el);
  lastSenderId = m.userId || m.user_id;
}

function buildMsgEl(m, confirmed) {
  const isOut = (m.userId || m.user_id) === state.me?.id || m.username === state.me?.username;
  const date = fmtDate(m.createdAt || m.created_at);
  const wrap = document.createElement("div");

  // Date divider
  if (date && date !== lastMsgDate) {
    lastMsgDate = date;
    const div = document.createElement("div"); div.className = "date-divider"; div.textContent = date;
    wrap.appendChild(div);
  }

  const row = document.createElement("div");
  row.className = `msg-row ${isOut ? "out" : "in"}`;
  row.dataset.msgId = m.id || "";
  row.dataset.clientId = m.clientId || "";
  if (isOut) row.dataset.isOwn = "1";

  const av = document.createElement("div");
  av.className = "msg-avatar";
  avatarEl(av, m.avatar, m.username);
  av.title = m.username || "";

  const bubble = document.createElement("div");
  bubble.className = "bubble" + (confirmed ? "" : " pending");
  if (!isOut) bubble.innerHTML += `<div class="sender">${esc(m.username)}</div>`;
  if (m.replyTo) {
    bubble.innerHTML += `<div class="reply-ref"><div class="reply-ref-name">${esc(m.replyToUsername || "")}</div><div class="reply-ref-text">${esc(m.replyToContent || "...")}</div></div>`;
  }

  bubble.innerHTML += buildBubbleBody(m);

  const reactions = document.createElement("div");
  reactions.className = "reactions-row";
  reactions.innerHTML = buildReactions(m.reactions, m.id, m.chatId);
  bubble.appendChild(reactions);

  const meta = document.createElement("div"); meta.className = "meta";
  const time = document.createElement("span"); time.className = "time"; time.textContent = fmt(m.createdAt || m.created_at);
  meta.appendChild(time);
  if (isOut) {
    const status = document.createElement("span"); status.className = "status";
    status.textContent = confirmed ? "✓✓" : "🕓";
    meta.appendChild(status);
  }
  if (m.edited) {
    const ed = document.createElement("span"); ed.className = "edited-mark"; ed.textContent = "змінено";
    meta.appendChild(ed);
  }
  bubble.appendChild(meta);

  row.appendChild(av);
  row.appendChild(bubble);
  wrap.appendChild(row);
  return wrap;
}

function buildBubbleBody(m) {
  if (m.type === "text") return `<div class="text">${esc(m.content)}</div>`;
  if (m.type === "image") {
    return `<img class="media" src="${m.fileUrl}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=media-placeholder>📷 Недоступно</div>'" onclick="openImg('${m.fileUrl}')"/>`;
  }
  if (m.type === "video") {
    return `<video class="media" src="${m.fileUrl}" controls preload="metadata"></video>`;
  }
  if (m.type === "voice") {
    const dur = m.content ? m.content + "с" : "";
    const bars = Array.from({ length: 24 }, () => `<span style="height:${3 + Math.random() * 16}px"></span>`).join("");
    return `<div class="voice-wrap">
      <button class="voice-play" onclick="toggleVoice(this)">▶</button>
      <div class="voice-wave">${bars}</div>
      <audio src="${m.fileUrl}" preload="none" style="display:none"></audio>
      <span class="voice-dur">${dur}</span>
    </div>`;
  }
  if (m.type === "sticker") {
    return `<img class="sticker-msg" src="${m.fileUrl}" alt="${esc(m.content)}" title="${esc(m.content)}" loading="lazy"/>`;
  }
  if (m.type === "file") {
    return `<div class="file-wrap">
      <div class="file-icon">📎</div>
      <div class="file-info">
        <div class="file-name"><a href="${m.fileUrl}" download="${esc(m.fileName)}" style="color:inherit;text-decoration:none">${esc(m.fileName || "Файл")}</a></div>
        <div class="file-size">${fmtSize(m.fileSize)}</div>
      </div>
    </div>`;
  }
  return `<div class="text">${esc(m.content)}</div>`;
}

window.toggleVoice = function(btn) {
  const audio = btn.parentElement.querySelector("audio");
  if (audio.paused) { audio.play(); btn.textContent = "⏸"; audio.onended = () => (btn.textContent = "▶"); }
  else { audio.pause(); btn.textContent = "▶"; }
};
window.openImg = function(url) {
  const ov = document.createElement("div");
  Object.assign(ov.style, { position: "fixed", inset: "0", background: "rgba(0,0,0,.9)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: "500", cursor: "zoom-out" });
  const img = document.createElement("img");
  Object.assign(img.style, { maxWidth: "95vw", maxHeight: "95vh", borderRadius: "12px" });
  img.src = url; ov.appendChild(img);
  ov.addEventListener("click", () => ov.remove());
  document.body.appendChild(ov);
};

function updateMsgStatus(clientId, chatId, id, status) {
  const el = document.querySelector(`[data-client-id="${clientId}"]`);
  if (!el) return;
  el.querySelector("[data-msg-id]")?.setAttribute("data-msg-id", id || "");
  el.querySelector(".status")?.textContent && (el.querySelector(".status").textContent = status);
  el.querySelector(".bubble")?.classList.remove("pending");
}

function onMessage(m) {
  const isCurrentChat = state.currentChat?.id === m.chatId;
  if (isCurrentChat) { renderMessage(m, true); scrollBottom(); }
  updateChatPreview(m);
  if (!isCurrentChat) {
    const c = state.chats.find(c => c.id === m.chatId);
    toast(`💬 ${m.username}: ${previewText(m)}`);
  }
}
function onMsgUpdated({ messageId, chatId, content, edited }) {
  const bubble = document.querySelector(`[data-msg-id="${messageId}"] .bubble, [data-msg-id="${messageId}"].bubble`);
  const el = document.querySelector(`[data-msg-id="${messageId}"]`)?.closest(".msg-row");
  if (!el) return;
  const textEl = el.querySelector(".text"); if (textEl) textEl.textContent = content;
  let edMark = el.querySelector(".edited-mark");
  if (!edMark && edited) { edMark = document.createElement("span"); edMark.className = "edited-mark"; edMark.textContent = "змінено"; el.querySelector(".meta")?.appendChild(edMark); }
}
function onMsgDeleted({ messageId }) {
  const el = document.querySelector(`[data-msg-id="${messageId}"]`)?.closest("[class]");
  if (el) {
    const textEl = el.querySelector(".text"); if (textEl) textEl.textContent = "Повідомлення видалено";
    const textEl2 = el.querySelector(".bubble"); if (textEl2) textEl2.style.opacity = ".4";
  }
}

// ─── Presence / typing ───────────────────────────────────────────────
function onPresence(list) {
  const chatId = state.currentChat?.id;
  if (!chatId) return;
  const onlineIds = new Set(list.map(u => u.userId));
}
function onTyping({ username, chatId, isTyping }) {
  if (username === state.me?.username || chatId !== state.currentChat?.id) return;
  activeTypers[username] = isTyping;
  const who = Object.entries(activeTypers).filter(([, v]) => v).map(([k]) => k);
  const bar = $("typingBar");
  if (who.length) { bar.textContent = who.join(", ") + (who.length === 1 ? " друкує..." : " друкують..."); bar.classList.remove("hidden"); }
  else bar.classList.add("hidden");
}

// ─── Ping / conn quality ─────────────────────────────────────────────
function setConn(level) { $("connIndicator").className = "conn-indicator " + level; }
function startPing() {
  setInterval(() => {
    if (!socket?.connected) return;
    const t0 = Date.now();
    socket.emit("ping-check", () => {
      const rtt = Date.now() - t0;
      setConn(rtt < 300 ? "good" : rtt < 900 ? "medium" : "bad");
    });
  }, 5000);
}

// ─── Scroll ───────────────────────────────────────────────────────────
function scrollBottom() {
  const el = $("messages");
  if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) el.scrollTop = el.scrollHeight;
}

// ─── Profile modal ────────────────────────────────────────────────────
$("profileBtn").addEventListener("click", openProfile);
$("meAvatar").addEventListener("click", openProfile);
function openProfile() {
  const u = state.me || {};
  $("profileDisplayName").value = u.display_name || "";
  $("profileBio").value = u.bio || "";
  $("profileUsernameDisplay").textContent = "@" + (u.username || "");
  avatarEl($("profileAvatarPreview"), u.avatar, u.display_name || u.username);
  openModal("profileModal");
}

$("profileAvatarInput").addEventListener("change", async () => {
  const file = $("profileAvatarInput").files[0]; if (!file) return;
  const blob = await compressImage(file, 256, 0.8);
  const r = await uploadBlob(blob, "avatar.jpg");
  avatarEl($("profileAvatarPreview"), r.url, "");
  $("profileAvatarPreview").dataset.pendingUrl = r.url;
});

$("saveProfileBtn").addEventListener("click", async () => {
  const payload = {
    display_name: $("profileDisplayName").value.trim(),
    bio: $("profileBio").value.trim(),
  };
  const pendingUrl = $("profileAvatarPreview").dataset.pendingUrl;
  if (pendingUrl) payload.avatar = pendingUrl;
  try {
    await api("PUT", "/api/profile", payload);
    Object.assign(state.me, payload);
    if (pendingUrl) state.me.avatar = pendingUrl;
    localStorage.setItem("yc_me", JSON.stringify(state.me));
    updateMeSidebar(); toast("✅ Профіль збережено"); closeModals();
  } catch (e) { toast("❌ " + e.message); }
});

$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem("yc_token"); localStorage.removeItem("yc_me");
  location.reload();
});

// ─── New chat modal ───────────────────────────────────────────────────
$("newChatBtn").addEventListener("click", () => openModal("newChatModal"));

let searchTimeout;
$("userSearchInput").addEventListener("input", () => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(searchUsers, 350);
});

async function searchUsers() {
  const q = $("userSearchInput").value.trim(); if (!q) return;
  try {
    const users = await api("GET", `/api/users/search?q=${encodeURIComponent(q)}`);
    const res = $("userSearchResults"); res.innerHTML = "";
    users.forEach(u => {
      const div = document.createElement("div"); div.className = "user-result";
      const av = document.createElement("div"); av.className = "user-result-avatar";
      avatarEl(av, u.avatar, u.display_name || u.username);
      div.appendChild(av);
      const info = document.createElement("div");
      info.innerHTML = `<div style="font-size:14px;font-weight:600">${esc(u.display_name || u.username)}</div><div style="font-size:12px;color:#8b8fa8">@${esc(u.username)}</div>`;
      div.appendChild(info);
      div.addEventListener("click", async () => {
        try {
          const chat = await api("POST", "/api/chats/dm", { userId: u.id });
          closeModals(); await loadChats();
          const full = state.chats.find(c => c.id === chat.id);
          if (full) openChat(full);
        } catch (e) { toast("❌ " + e.message); }
      });
      res.appendChild(div);
    });
  } catch {}
}

// ─── Search in sidebar ────────────────────────────────────────────────
$("searchInput").addEventListener("input", () => {
  const q = $("searchInput").value.toLowerCase();
  if (!q) { renderChatList(); return; }
  renderChatList(state.chats.filter(c => {
    const name = c.name || c.partner?.username || "";
    return name.toLowerCase().includes(q);
  }));
});

// ─── Modal helpers ────────────────────────────────────────────────────
function openModal(id) { $(id).classList.remove("hidden"); }
function closeModals() {
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
}
document.querySelectorAll(".modal-close").forEach(btn => {
  btn.addEventListener("click", closeModals);
});
document.querySelectorAll(".modal").forEach(m => {
  m.addEventListener("click", e => { if (e.target === m) closeModals(); });
});

// ─── Push notifications ──────────────────────────────────────────────
async function registerPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
  try {
    const { key } = await fetch("/api/push/vapid-key").then(r => r.json());
    if (!key) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });
    await api("POST", "/api/push/subscribe", sub.toJSON());
  } catch {}
}
function urlBase64ToUint8Array(base64) {
  const p = (base64 + "=".repeat((4 - base64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(p); return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

// ─── Service worker ──────────────────────────────────────────────────
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js")
      .then(() => setTimeout(registerPush, 2000))
      .catch(() => {});
  }
}

// ─── Init ─────────────────────────────────────────────────────────────
if (state.token && state.me) showApp();
else showAuth();
