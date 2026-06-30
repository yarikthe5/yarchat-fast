// ---------------- Yarchat client ----------------
const $ = (id) => document.getElementById(id);

const loginScreen = $("loginScreen");
const appScreen = $("appScreen");
const usernameInput = $("usernameInput");
const avatarInput = $("avatarInput");
const avatarPreview = $("avatarPreview");
const enterBtn = $("enterBtn");

const messagesEl = $("messages");
const messageInput = $("messageInput");
const sendBtn = $("sendBtn");
const attachBtn = $("attachBtn");
const fileInput = $("fileInput");
const micBtn = $("micBtn");
const onlineCountEl = $("onlineCount");
const connIndicator = $("connIndicator");
const systemBanner = $("systemBanner");
const typingIndicator = $("typingIndicator");
const saveModeBtn = $("saveModeBtn");
const recordingBar = $("recordingBar");
const recTimer = $("recTimer");
const cancelRecBtn = $("cancelRecBtn");

let me = JSON.parse(localStorage.getItem("yarchat_me") || "null");
let saveMode = localStorage.getItem("yarchat_savemode") === "1";
let socket = null;
let pendingAvatarUrl = "";
let typingTimeout = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordStart = 0;
let recordTimerInterval = null;

// IndexedDB-free simple offline queue via localStorage (small payloads — files already uploaded as URLs before queueing when possible)
const QUEUE_KEY = "yarchat_queue";
function getQueue() { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); }
function setQueue(q) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
function pushQueue(item) { const q = getQueue(); q.push(item); setQueue(q); }
function removeFromQueue(clientId) { setQueue(getQueue().filter((m) => m.clientId !== clientId)); }

// Local cache of last messages for instant offline render
const CACHE_KEY = "yarchat_cache";
function cacheMessages(list) {
  localStorage.setItem(CACHE_KEY, JSON.stringify(list.slice(-80)));
}
function loadCache() {
  return JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
}

if (saveMode) saveModeBtn.classList.add("active");

// ---------- Login ----------
if (me) {
  showApp();
}

avatarInput.addEventListener("change", async () => {
  const file = avatarInput.files[0];
  if (!file) return;
  const compressed = await compressImage(file, 256, 0.7);
  const url = await uploadBlob(compressed, "avatar.jpg");
  pendingAvatarUrl = url;
  avatarPreview.style.backgroundImage = `url(${url})`;
  avatarPreview.textContent = "";
});

usernameInput.addEventListener("input", () => {
  if (!pendingAvatarUrl) {
    avatarPreview.textContent = (usernameInput.value.trim()[0] || "?").toUpperCase();
  }
});

enterBtn.addEventListener("click", () => {
  const name = usernameInput.value.trim();
  if (!name) {
    usernameInput.focus();
    return;
  }
  me = { username: name, avatar: pendingAvatarUrl || "" };
  localStorage.setItem("yarchat_me", JSON.stringify(me));
  showApp();
});

function showApp() {
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");
  initSocket();
  registerSW();
  renderCached();
}

function renderCached() {
  const cached = loadCache();
  cached.forEach((m) => renderMessage(m, true));
  scrollToBottom();
}

// ---------- Socket ----------
function initSocket() {
  socket = io({ reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 5000 });

  socket.on("connect", () => {
    socket.emit("join", { username: me.username, avatar: me.avatar });
    showBanner("Підключено", true);
    flushQueue();
    startPing();
  });

  socket.on("disconnect", () => {
    setConnIndicator("bad");
    showBanner("Немає з'єднання — повідомлення будуть надіслані пізніше", false);
  });

  socket.on("history", (history) => {
    messagesEl.innerHTML = "";
    history.forEach((m) => renderMessage(m, true));
    // re-add still-pending local queue items visually
    getQueue().forEach((m) => renderMessage(m, false));
    cacheMessages(history);
    scrollToBottom();
  });

  socket.on("message", (m) => {
    cacheAppend(m);
    const existing = document.querySelector(`[data-client-id="${m.clientId}"]`);
    if (existing) {
      existing.outerHTML = buildBubble(m, true);
    } else {
      renderMessage(m, true);
    }
    scrollToBottom();
  });

  socket.on("presence", (list) => {
    onlineCountEl.textContent = `онлайн: ${list.length}`;
  });

  socket.on("system", ({ text }) => showBanner(text, true, 2500));

  socket.on("typing", ({ username, isTyping }) => {
    if (username === me.username) return;
    typingIndicator.textContent = isTyping ? `${username} друкує...` : "";
    typingIndicator.classList.toggle("hidden", !isTyping);
  });

  socket.on("reaction-update", ({ messageId, reactions }) => {
    const el = document.querySelector(`[data-id="${messageId}"] .reactions`);
    if (el) el.innerHTML = renderReactions(reactions, messageId);
  });
}

function showBanner(text, ok, autoHideMs) {
  systemBanner.textContent = text;
  systemBanner.classList.remove("hidden");
  systemBanner.style.color = ok ? "" : "#ff8a80";
  if (autoHideMs) setTimeout(() => systemBanner.classList.add("hidden"), autoHideMs);
}

// ---------- Connection quality ----------
function setConnIndicator(level) {
  connIndicator.className = "conn-indicator " + level;
}
function startPing() {
  setInterval(() => {
    if (!socket.connected) return;
    const t0 = Date.now();
    socket.emit("ping-check", () => {
      const rtt = Date.now() - t0;
      if (rtt < 250) setConnIndicator("good");
      else if (rtt < 800) setConnIndicator("medium");
      else setConnIndicator("bad");
    });
  }, 4000);
}

// ---------- Sending text ----------
sendBtn.addEventListener("click", sendTextMessage);
messageInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") sendTextMessage();
});
messageInput.addEventListener("input", () => {
  socket?.emit("typing", { username: me.username, isTyping: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket?.emit("typing", { username: me.username, isTyping: false });
  }, 1200);
});

function sendTextMessage() {
  const text = messageInput.value.trim();
  if (!text) return;
  messageInput.value = "";
  queueAndSend({ type: "text", content: text });
}

function queueAndSend(payload) {
  const clientId = "c" + Date.now() + Math.random().toString(36).slice(2);
  const msg = {
    clientId,
    room: "general",
    username: me.username,
    avatar: me.avatar,
    type: payload.type,
    content: payload.content || "",
    fileUrl: payload.fileUrl || "",
    createdAt: new Date().toISOString(),
  };
  renderMessage(msg, false);
  scrollToBottom();

  if (socket && socket.connected) {
    trySend(msg);
  } else {
    pushQueue(msg);
  }
}

function trySend(msg) {
  socket.emit("message", msg, (ack) => {
    if (ack && ack.ok) {
      removeFromQueue(msg.clientId);
      const el = document.querySelector(`[data-client-id="${msg.clientId}"]`);
      if (el) {
        const statusEl = el.querySelector(".status");
        if (statusEl) statusEl.textContent = "✓✓";
        el.classList.remove("pending");
      }
    } else {
      pushQueue(msg);
    }
  });
}

function flushQueue() {
  const q = getQueue();
  q.forEach((m) => trySend(m));
}

window.addEventListener("online", () => socket && !socket.connected && socket.connect());

// ---------- Image / video attach with offline compression ----------
attachBtn.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (!file) return;

  if (file.type.startsWith("image/")) {
    const quality = saveMode ? 0.5 : 0.7;
    const maxDim = saveMode ? 800 : 1280;
    showBanner("Стискаю зображення...", true);
    const compressed = await compressImage(file, maxDim, quality);
    const url = await uploadBlob(compressed, "photo.jpg");
    systemBanner.classList.add("hidden");
    queueAndSend({ type: "image", fileUrl: url });
  } else if (file.type.startsWith("video/")) {
    if (file.size > 20 * 1024 * 1024) {
      alert("Відео завелике для слабкого інтернету (>20MB). Запиши коротше відео або зменш якість у налаштуваннях камери.");
      return;
    }
    showBanner("Завантажую відео...", true);
    const url = await uploadBlob(file, file.name || "video.mp4");
    systemBanner.classList.add("hidden");
    queueAndSend({ type: "video", fileUrl: url });
  }
});

function compressImage(file, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = (e) => (img.src = e.target.result);
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round((height * maxDim) / width);
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round((width * maxDim) / height);
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    };
    reader.readAsDataURL(file);
  });
}

async function uploadBlob(blob, filename) {
  const fd = new FormData();
  fd.append("file", blob, filename);
  const res = await fetch("/upload", { method: "POST", body: fd });
  const data = await res.json();
  return data.url;
}

// ---------- Voice messages ----------
let pressTimer = null;
micBtn.addEventListener("mousedown", startRecording);
micBtn.addEventListener("touchstart", (e) => { e.preventDefault(); startRecording(); });
micBtn.addEventListener("mouseup", stopRecording);
micBtn.addEventListener("touchend", (e) => { e.preventDefault(); stopRecording(); });
cancelRecBtn.addEventListener("click", () => {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.cancelled = true;
    mediaRecorder.stop();
  }
});

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 24000 });
    mediaRecorder.ondataavailable = (e) => recordedChunks.push(e.data);
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      recordingBar.classList.add("hidden");
      clearInterval(recordTimerInterval);
      if (mediaRecorder.cancelled) return;
      if (Date.now() - recordStart < 600) return; // too short
      const blob = new Blob(recordedChunks, { type: "audio/webm" });
      showBanner("Завантажую голосове...", true);
      const url = await uploadBlob(blob, "voice.webm");
      systemBanner.classList.add("hidden");
      const duration = Math.round((Date.now() - recordStart) / 1000);
      queueAndSend({ type: "voice", fileUrl: url, content: String(duration) });
    };
    mediaRecorder.start();
    recordStart = Date.now();
    recordingBar.classList.remove("hidden");
    recordTimerInterval = setInterval(() => {
      const s = Math.floor((Date.now() - recordStart) / 1000);
      recTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    }, 200);
  } catch (e) {
    alert("Немає доступу до мікрофона");
  }
}
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
}

// ---------- Save mode ----------
saveModeBtn.addEventListener("click", () => {
  saveMode = !saveMode;
  localStorage.setItem("yarchat_savemode", saveMode ? "1" : "0");
  saveModeBtn.classList.toggle("active", saveMode);
  showBanner(saveMode ? "Режим економії трафіку увімкнено" : "Режим економії трафіку вимкнено", true, 2000);
});

// ---------- Rendering ----------
function cacheAppend(m) {
  const c = loadCache();
  c.push(m);
  cacheMessages(c);
}

function renderMessage(m, confirmed) {
  const existing = document.querySelector(`[data-client-id="${m.clientId}"]`);
  if (existing) return;
  messagesEl.insertAdjacentHTML("beforeend", buildBubble(m, confirmed));
  const el = messagesEl.lastElementChild;
  el.addEventListener("dblclick", () => {
    socket?.emit("reaction", { messageId: m.id, emoji: "👍", username: me.username });
  });
}

function initials(name) {
  return (name || "?").trim()[0]?.toUpperCase() || "?";
}

function avatarStyle(avatar) {
  return avatar ? `style="background-image:url(${avatar})"` : "";
}

function buildBubble(m, confirmed) {
  const out = m.username === me.username;
  const time = new Date(m.createdAt).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
  const status = out ? `<span class="status">${confirmed ? "✓✓" : "🕓"}</span>` : "";

  let body = "";
  if (m.type === "text") {
    body = `<div class="text">${escapeHtml(m.content)}</div>`;
  } else if (m.type === "image") {
    body = `<img class="media" src="${m.fileUrl}" loading="lazy" />`;
  } else if (m.type === "video") {
    body = `<video class="media" src="${m.fileUrl}" controls preload="metadata"></video>`;
  } else if (m.type === "voice") {
    body = `<div class="voice-msg">
      <button class="voice-play" onclick="this.nextElementSibling.nextElementSibling.play()">▶</button>
      <div class="voice-wave">${"".padStart(18, "|").split("").map(() => `<span style="height:${4 + Math.random() * 16}px"></span>`).join("")}</div>
      <audio src="${m.fileUrl}" style="display:none" preload="none"></audio>
      <span style="font-size:11px;color:rgba(255,255,255,.6)">${m.content || ""}s</span>
    </div>`;
  }

  return `<div class="msg-row ${out ? "out" : "in"} ${!confirmed ? "pending" : ""}" data-client-id="${m.clientId || ""}" data-id="${m.id || ""}">
    <div class="msg-avatar" ${avatarStyle(m.avatar)}>${m.avatar ? "" : initials(m.username)}</div>
    <div class="bubble">
      ${!out ? `<div class="sender">${escapeHtml(m.username)}</div>` : ""}
      ${body}
      <div class="reactions">${renderReactions(m.reactions, m.id)}</div>
      <div class="meta"><span class="time">${time}</span>${status}</div>
    </div>
  </div>`;
}

function renderReactions(reactions, messageId) {
  if (!reactions) return "";
  return Object.entries(reactions)
    .map(([emoji, users]) => `<span class="reaction-chip">${emoji} ${users.length}</span>`)
    .join("");
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- Service worker ----------
function registerSW() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}
