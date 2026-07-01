import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pkg from "pg";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import webpush from "web-push";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 8000,
  pingTimeout: 6000,
  maxHttpBufferSize: 10e6,
});

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "yarchat_dev_secret_xZ9k";
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
let pushEnabled = false;
if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails("mailto:admin@yarchat.app", VAPID_PUBLIC, VAPID_PRIVATE);
  pushEnabled = true;
}

// ─── DB ───────────────────────────────────────────────────────────────────────
let pool = null;
let dbReady = false;

async function q(text, params) {
  if (!pool) throw new Error("DB not ready");
  return pool.query(text, params);
}

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set — using in-memory mode");
    return;
  }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      bio TEXT DEFAULT '',
      push_subscription JSONB,
      created_at TIMESTAMPTZ DEFAULT now(),
      last_seen TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'group',
      name TEXT,
      avatar TEXT DEFAULT '',
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      last_read_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chat_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      client_id TEXT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT,
      avatar TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT DEFAULT '',
      file_url TEXT,
      file_name TEXT,
      file_size INTEGER,
      reply_to INTEGER,
      reactions JSONB DEFAULT '{}',
      edited BOOLEAN DEFAULT false,
      deleted BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS stickers (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      username TEXT,
      name TEXT,
      image_url TEXT NOT NULL,
      pack TEXT DEFAULT 'default',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS map_pins (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      user_id INTEGER,
      username TEXT,
      lat FLOAT NOT NULL,
      lng FLOAT NOT NULL,
      title TEXT DEFAULT '',
      description TEXT DEFAULT '',
      meet_time TEXT,
      color TEXT DEFAULT '#8b5cf6',
      created_at TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS map_drawings (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER NOT NULL,
      user_id INTEGER,
      points JSONB NOT NULL,
      color TEXT DEFAULT '#8b5cf6',
      width INTEGER DEFAULT 3,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Ensure general chat exists
  const g = await q("SELECT id FROM chats WHERE id = 1");
  if (!g.rows.length) {
    await q("INSERT INTO chats (id, type, name) VALUES (1, 'group', 'Загальний чат') ON CONFLICT DO NOTHING");
    await q("SELECT setval('chats_id_seq', GREATEST((SELECT MAX(id) FROM chats), 1))");
  }

  dbReady = true;
  console.log("Postgres ready ✓");
}

// ─── In-memory fallback ───────────────────────────────────────────────────────
const mem = {
  users: [], messages: [], nextMsgId: 1,
  chats: [{ id: 1, type: "group", name: "Загальний чат", avatar: "", created_at: new Date() }],
  members: [], stickers: [], mapPins: [], mapDrawings: [],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function verifyToken(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : req.query.token;
  if (!token) return res.status(401).json({ error: "Unauthorized" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

function verifySocketToken(token) {
  try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

async function isMember(userId, chatId) {
  if (!dbReady) return mem.members.some(m => m.user_id === userId && m.chat_id === chatId);
  const r = await q("SELECT 1 FROM chat_members WHERE user_id=$1 AND chat_id=$2", [userId, chatId]);
  return r.rows.length > 0;
}

async function getChatMembers(chatId) {
  if (!dbReady) return mem.members.filter(m => m.chat_id === chatId).map(m => m.user_id);
  const r = await q("SELECT user_id FROM chat_members WHERE chat_id=$1", [chatId]);
  return r.rows.map(r => r.user_id);
}

async function sendPushToUser(userId, payload) {
  if (!pushEnabled || !dbReady) return;
  try {
    const r = await q("SELECT push_subscription FROM users WHERE id=$1 AND push_subscription IS NOT NULL", [userId]);
    if (!r.rows.length) return;
    await webpush.sendNotification(r.rows[0].push_subscription, JSON.stringify(payload));
  } catch {}
}

// ─── Static & uploads ─────────────────────────────────────────────────────────
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB — client compresses

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  res.json({ url: `/uploads/${req.file.filename}`, name: req.file.originalname, size: req.file.size });
});

// ─── Auth ─────────────────────────────────────────────────────────────────────
app.post("/api/register", async (req, res) => {
  const { username, password, display_name } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  if (!/^[a-zA-Z0-9_]{2,20}$/.test(username)) return res.status(400).json({ error: "Username: 2-20 chars, letters/digits/underscore" });
  if (password.length < 4) return res.status(400).json({ error: "Password min 4 chars" });

  const hash = await bcrypt.hash(password, 10);
  try {
    if (!dbReady) {
      if (mem.users.find(u => u.username === username)) return res.status(409).json({ error: "Username taken" });
      const user = { id: mem.users.length + 1, username, display_name: display_name || username, password_hash: hash, avatar: "", bio: "" };
      mem.users.push(user);
      mem.members.push({ chat_id: 1, user_id: user.id });
      const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
      return res.json({ token, user: { id: user.id, username, display_name: user.display_name, avatar: "", bio: "" } });
    }
    const r = await q(
      "INSERT INTO users (username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING id",
      [username, display_name || username, hash]
    );
    const uid = r.rows[0].id;
    await q("INSERT INTO chat_members (chat_id, user_id) VALUES (1, $1) ON CONFLICT DO NOTHING", [uid]);
    const token = jwt.sign({ id: uid, username }, JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: uid, username, display_name: display_name || username, avatar: "", bio: "" } });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "Username taken" });
    res.status(500).json({ error: "Server error" });
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Required" });
  if (!dbReady) {
    const user = mem.users.find(u => u.username === username);
    if (!user || !await bcrypt.compare(password, user.password_hash)) return res.status(401).json({ error: "Wrong credentials" });
    const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
    return res.json({ token, user: { id: user.id, username, display_name: user.display_name, avatar: user.avatar, bio: user.bio } });
  }
  const r = await q("SELECT * FROM users WHERE username=$1", [username]);
  if (!r.rows.length || !await bcrypt.compare(password, r.rows[0].password_hash)) return res.status(401).json({ error: "Wrong credentials" });
  const u = r.rows[0];
  await q("UPDATE users SET last_seen=now() WHERE id=$1", [u.id]);
  const token = jwt.sign({ id: u.id, username: u.username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar, bio: u.bio } });
});

// ─── Profile ──────────────────────────────────────────────────────────────────
app.get("/api/me", verifyToken, async (req, res) => {
  if (!dbReady) {
    const u = mem.users.find(u => u.id === req.user.id);
    return res.json(u ? { id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar, bio: u.bio } : {});
  }
  const r = await q("SELECT id,username,display_name,avatar,bio FROM users WHERE id=$1", [req.user.id]);
  res.json(r.rows[0] || {});
});

app.put("/api/profile", verifyToken, async (req, res) => {
  const { display_name, bio, avatar } = req.body;
  if (!dbReady) {
    const u = mem.users.find(u => u.id === req.user.id);
    if (u) { u.display_name = display_name || u.display_name; u.bio = bio ?? u.bio; u.avatar = avatar ?? u.avatar; }
    return res.json({ ok: true });
  }
  await q("UPDATE users SET display_name=COALESCE($1,display_name), bio=COALESCE($2,bio), avatar=COALESCE($3,avatar) WHERE id=$4",
    [display_name, bio, avatar, req.user.id]);
  // Update avatar in recent messages
  if (avatar !== undefined) {
    await q("UPDATE messages SET avatar=$1 WHERE user_id=$2 AND created_at > now() - interval '7 days'", [avatar, req.user.id]);
  }
  res.json({ ok: true });
});

// ─── Users search ─────────────────────────────────────────────────────────────
app.get("/api/users/search", verifyToken, async (req, res) => {
  const q2 = (req.query.q || "").trim();
  if (!q2) return res.json([]);
  if (!dbReady) return res.json(mem.users.filter(u => u.username.includes(q2) && u.id !== req.user.id)
    .map(u => ({ id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar })));
  const r = await q("SELECT id,username,display_name,avatar FROM users WHERE username ILIKE $1 AND id!=$2 LIMIT 10",
    [`%${q2}%`, req.user.id]);
  res.json(r.rows);
});

// ─── Chats ────────────────────────────────────────────────────────────────────
app.get("/api/chats", verifyToken, async (req, res) => {
  if (!dbReady) {
    const myIds = mem.members.filter(m => m.user_id === req.user.id).map(m => m.chat_id);
    return res.json(mem.chats.filter(c => myIds.includes(c.id)).map(c => ({
      ...c,
      unread: 0,
      last_message: mem.messages.filter(m => m.chat_id === c.id).slice(-1)[0] || null,
    })));
  }
  const r = await q(`
    SELECT c.id, c.type, c.name, c.avatar, c.created_by,
      (SELECT row_to_json(m) FROM (
        SELECT type,content,file_url,username,created_at FROM messages
        WHERE chat_id=c.id AND deleted=false ORDER BY id DESC LIMIT 1
      ) m) as last_message
    FROM chats c JOIN chat_members cm ON c.id=cm.chat_id
    WHERE cm.user_id=$1
    ORDER BY COALESCE((
      SELECT created_at FROM messages WHERE chat_id=c.id ORDER BY id DESC LIMIT 1
    ), c.created_at) DESC
  `, [req.user.id]);
  // For DMs — attach partner info
  const chats = await Promise.all(r.rows.map(async chat => {
    if (chat.type === "dm") {
      const members = await q(
        "SELECT u.id,u.username,u.display_name,u.avatar FROM users u JOIN chat_members cm ON u.id=cm.user_id WHERE cm.chat_id=$1 AND u.id!=$2",
        [chat.id, req.user.id]
      );
      if (members.rows.length) {
        chat.partner = members.rows[0];
        chat.name = members.rows[0].display_name || members.rows[0].username;
        chat.avatar = members.rows[0].avatar;
      }
    }
    return chat;
  }));
  res.json(chats);
});

app.post("/api/chats/dm", verifyToken, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: "userId required" });
  if (!dbReady) {
    const target = mem.users.find(u => u.id === userId);
    if (!target) return res.status(404).json({ error: "User not found" });
    const existing = mem.chats.find(c => c.type === "dm" &&
      mem.members.filter(m => m.chat_id === c.id).map(m => m.user_id).sort().join(",") === [req.user.id, userId].sort().join(","));
    if (existing) return res.json(existing);
    const chat = { id: mem.chats.length + 1, type: "dm", name: target.display_name, avatar: target.avatar, created_at: new Date() };
    mem.chats.push(chat);
    mem.members.push({ chat_id: chat.id, user_id: req.user.id });
    mem.members.push({ chat_id: chat.id, user_id: userId });
    return res.json(chat);
  }
  // Check existing DM
  const existing = await q(`
    SELECT c.id FROM chats c
    JOIN chat_members cm1 ON c.id=cm1.chat_id AND cm1.user_id=$1
    JOIN chat_members cm2 ON c.id=cm2.chat_id AND cm2.user_id=$2
    WHERE c.type='dm' LIMIT 1
  `, [req.user.id, userId]);
  if (existing.rows.length) return res.json({ id: existing.rows[0].id });
  const nr = await q("INSERT INTO chats (type, created_by) VALUES ('dm', $1) RETURNING id", [req.user.id]);
  const chatId = nr.rows[0].id;
  await q("INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3)", [chatId, req.user.id, userId]);
  res.json({ id: chatId });
});

// ─── Messages ─────────────────────────────────────────────────────────────────
app.get("/api/chats/:chatId/messages", verifyToken, async (req, res) => {
  const chatId = parseInt(req.params.chatId);
  const before = req.query.before ? parseInt(req.query.before) : null;
  if (!dbReady) {
    let msgs = mem.messages.filter(m => m.chat_id === chatId);
    if (before) msgs = msgs.filter(m => m.id < before);
    return res.json(msgs.slice(-50));
  }
  if (!await isMember(req.user.id, chatId)) return res.status(403).json({ error: "Not a member" });
  const r = await q(
    `SELECT id, client_id as "clientId", chat_id as "chatId", user_id as "userId",
      username, avatar, type, content, file_url as "fileUrl", file_name as "fileName",
      file_size as "fileSize", reply_to as "replyTo", reactions, edited, deleted, created_at as "createdAt"
     FROM messages WHERE chat_id=$1 ${before ? "AND id < " + before : ""}
     AND deleted=false ORDER BY id DESC LIMIT 50`,
    [chatId]
  );
  res.json(r.rows.reverse());
});

// ─── Stickers ─────────────────────────────────────────────────────────────────
app.get("/api/stickers", verifyToken, async (req, res) => {
  if (!dbReady) return res.json(mem.stickers);
  const r = await q("SELECT * FROM stickers ORDER BY created_at DESC LIMIT 200");
  res.json(r.rows);
});

app.post("/api/stickers", verifyToken, async (req, res) => {
  const { name, image_url, pack } = req.body;
  if (!image_url) return res.status(400).json({ error: "image_url required" });
  if (!dbReady) {
    const s = { id: mem.stickers.length + 1, user_id: req.user.id, username: req.user.username, name, image_url, pack: pack || "default" };
    mem.stickers.push(s);
    return res.json(s);
  }
  const r = await q(
    "INSERT INTO stickers (user_id, username, name, image_url, pack) VALUES ($1,$2,$3,$4,$5) RETURNING *",
    [req.user.id, req.user.username, name, image_url, pack || "default"]
  );
  res.json(r.rows[0]);
});

// ─── Map ──────────────────────────────────────────────────────────────────────
app.get("/api/chats/:chatId/map", verifyToken, async (req, res) => {
  const chatId = parseInt(req.params.chatId);
  if (!dbReady) return res.json({
    pins: mem.mapPins.filter(p => p.chat_id === chatId),
    drawings: mem.mapDrawings.filter(d => d.chat_id === chatId),
  });
  const pins = await q("SELECT * FROM map_pins WHERE chat_id=$1 ORDER BY id", [chatId]);
  const drawings = await q("SELECT * FROM map_drawings WHERE chat_id=$1 ORDER BY id", [chatId]);
  res.json({ pins: pins.rows, drawings: drawings.rows });
});

// ─── Push ─────────────────────────────────────────────────────────────────────
app.get("/api/push/vapid-key", (req, res) => res.json({ key: VAPID_PUBLIC }));

app.post("/api/push/subscribe", verifyToken, async (req, res) => {
  const sub = req.body;
  if (!dbReady) return res.json({ ok: true });
  await q("UPDATE users SET push_subscription=$1 WHERE id=$2", [JSON.stringify(sub), req.user.id]);
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true, db: dbReady, push: pushEnabled }));

// ─── Socket.IO ───────────────────────────────────────────────────────────────
const onlineUsers = new Map(); // socket.id → {userId, username, avatar}

io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  const user = verifySocketToken(token);
  if (!user) return next(new Error("Unauthorized"));
  socket.data.user = user;
  next();
});

io.on("connection", async (socket) => {
  const { id: userId, username } = socket.data.user;

  // Get user profile
  let avatar = "";
  let displayName = username;
  if (dbReady) {
    const r = await q("SELECT avatar, display_name FROM users WHERE id=$1", [userId]).catch(() => ({ rows: [] }));
    if (r.rows[0]) { avatar = r.rows[0].avatar; displayName = r.rows[0].display_name; }
    await q("UPDATE users SET last_seen=now() WHERE id=$1", [userId]);
  } else {
    const u = mem.users.find(u => u.id === userId);
    if (u) { avatar = u.avatar; displayName = u.display_name; }
  }

  socket.data.avatar = avatar;
  socket.data.displayName = displayName;
  onlineUsers.set(socket.id, { userId, username, displayName, avatar });

  // Join user's chat rooms
  let chatIds = [];
  if (dbReady) {
    const r = await q("SELECT chat_id FROM chat_members WHERE user_id=$1", [userId]).catch(() => ({ rows: [] }));
    chatIds = r.rows.map(r => r.chat_id);
  } else {
    chatIds = mem.members.filter(m => m.user_id === userId).map(m => m.chat_id);
  }
  chatIds.forEach(id => socket.join(`chat_${id}`));

  io.emit("presence", Array.from(onlineUsers.values()));

  // ── message ──
  socket.on("message", async (data, ack) => {
    const { clientId, chatId, type, content, fileUrl, fileName, fileSize, replyTo } = data;
    try {
      if (!dbReady) {
        const msg = {
          id: mem.nextMsgId++, clientId, chat_id: chatId, user_id: userId,
          username, avatar, type, content: content || "", fileUrl, fileName, fileSize,
          replyTo: replyTo || null, reactions: {}, edited: false, deleted: false, createdAt: new Date().toISOString(),
        };
        mem.messages.push(msg);
        if (mem.messages.length > 2000) mem.messages.shift();
        io.to(`chat_${chatId}`).emit("message", { ...msg, chatId });
        if (typeof ack === "function") ack({ ok: true, id: msg.id, clientId });
        return;
      }
      if (!await isMember(userId, chatId)) throw new Error("Not member");
      const r = await q(
        `INSERT INTO messages (client_id, chat_id, user_id, username, avatar, type, content, file_url, file_name, file_size, reply_to)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, created_at`,
        [clientId, chatId, userId, username, avatar, type, content || "", fileUrl || null, fileName || null, fileSize || null, replyTo || null]
      );
      const saved = {
        id: r.rows[0].id, clientId, chatId, userId, username, avatar,
        type, content: content || "", fileUrl, fileName, fileSize, replyTo: replyTo || null,
        reactions: {}, edited: false, deleted: false, createdAt: r.rows[0].created_at,
      };
      io.to(`chat_${chatId}`).emit("message", saved);
      if (typeof ack === "function") ack({ ok: true, id: saved.id, clientId });
      // Push to offline members
      const members = await getChatMembers(chatId);
      const onlineIds = new Set([...onlineUsers.values()].map(u => u.userId));
      members.filter(mid => mid !== userId && !onlineIds.has(mid)).forEach(mid => {
        sendPushToUser(mid, { title: displayName || username, body: type === "text" ? content : `📎 ${type}`, chatId });
      });
    } catch (e) {
      if (typeof ack === "function") ack({ ok: false, error: e.message, clientId });
    }
  });

  // ── typing ──
  socket.on("typing", ({ chatId, isTyping }) => {
    socket.to(`chat_${chatId}`).emit("typing", { username, chatId, isTyping });
  });

  // ── reaction ──
  socket.on("reaction", async ({ messageId, chatId, emoji }) => {
    try {
      let reactions;
      if (!dbReady) {
        const m = mem.messages.find(x => x.id === messageId);
        if (!m) return;
        m.reactions = m.reactions || {};
        if (!m.reactions[emoji]) m.reactions[emoji] = [];
        const i = m.reactions[emoji].indexOf(username);
        if (i > -1) m.reactions[emoji].splice(i, 1); else m.reactions[emoji].push(username);
        if (!m.reactions[emoji].length) delete m.reactions[emoji];
        reactions = m.reactions;
      } else {
        const rm = await q("SELECT reactions FROM messages WHERE id=$1", [messageId]);
        if (!rm.rows.length) return;
        reactions = rm.rows[0].reactions || {};
        if (!reactions[emoji]) reactions[emoji] = [];
        const i = reactions[emoji].indexOf(username);
        if (i > -1) reactions[emoji].splice(i, 1); else reactions[emoji].push(username);
        if (!reactions[emoji].length) delete reactions[emoji];
        await q("UPDATE messages SET reactions=$1 WHERE id=$2", [JSON.stringify(reactions), messageId]);
      }
      io.to(`chat_${chatId}`).emit("reaction-update", { messageId, chatId, reactions });
    } catch {}
  });

  // ── edit ──
  socket.on("message:edit", async ({ messageId, chatId, content }) => {
    try {
      if (!dbReady) {
        const m = mem.messages.find(x => x.id === messageId && x.user_id === userId);
        if (m) { m.content = content; m.edited = true; }
      } else {
        await q("UPDATE messages SET content=$1, edited=true WHERE id=$2 AND user_id=$3", [content, messageId, userId]);
      }
      io.to(`chat_${chatId}`).emit("message:updated", { messageId, chatId, content, edited: true });
    } catch {}
  });

  // ── delete ──
  socket.on("message:delete", async ({ messageId, chatId }) => {
    try {
      if (!dbReady) {
        const m = mem.messages.find(x => x.id === messageId && x.user_id === userId);
        if (m) m.deleted = true;
      } else {
        await q("UPDATE messages SET deleted=true WHERE id=$1 AND user_id=$2", [messageId, userId]);
      }
      io.to(`chat_${chatId}`).emit("message:deleted", { messageId, chatId });
    } catch {}
  });

  // ── join new chat ──
  socket.on("chat:join", (chatId) => socket.join(`chat_${chatId}`));

  // ── map ──
  socket.on("map:pin-add", async ({ chatId, lat, lng, title, description, meet_time, color }) => {
    try {
      let pin;
      if (!dbReady) {
        pin = { id: Date.now(), chat_id: chatId, user_id: userId, username, lat, lng, title, description, meet_time, color };
        mem.mapPins.push(pin);
      } else {
        const r = await q(
          "INSERT INTO map_pins (chat_id, user_id, username, lat, lng, title, description, meet_time, color) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *",
          [chatId, userId, username, lat, lng, title || "", description || "", meet_time || null, color || "#8b5cf6"]
        );
        pin = r.rows[0];
      }
      io.to(`chat_${chatId}`).emit("map:pin", pin);
    } catch {}
  });

  socket.on("map:pin-delete", async ({ chatId, pinId }) => {
    try {
      if (!dbReady) {
        mem.mapPins = mem.mapPins.filter(p => !(p.id === pinId && p.user_id === userId));
      } else {
        await q("DELETE FROM map_pins WHERE id=$1 AND user_id=$2", [pinId, userId]);
      }
      io.to(`chat_${chatId}`).emit("map:pin-deleted", { pinId, chatId });
    } catch {}
  });

  socket.on("map:draw", async ({ chatId, points, color, width }) => {
    try {
      let drawing;
      if (!dbReady) {
        drawing = { id: Date.now(), chat_id: chatId, user_id: userId, points, color, width };
        mem.mapDrawings.push(drawing);
      } else {
        const r = await q(
          "INSERT INTO map_drawings (chat_id, user_id, points, color, width) VALUES ($1,$2,$3,$4,$5) RETURNING *",
          [chatId, userId, JSON.stringify(points), color || "#8b5cf6", width || 3]
        );
        drawing = r.rows[0];
      }
      io.to(`chat_${chatId}`).emit("map:drawn", drawing);
    } catch {}
  });

  socket.on("map:clear-drawings", async ({ chatId }) => {
    try {
      if (!dbReady) mem.mapDrawings = mem.mapDrawings.filter(d => d.chat_id !== chatId);
      else await q("DELETE FROM map_drawings WHERE chat_id=$1", [chatId]);
      io.to(`chat_${chatId}`).emit("map:cleared", { chatId });
    } catch {}
  });

  // ── ping ──
  socket.on("ping-check", (cb) => { if (typeof cb === "function") cb(Date.now()); });

  // ── disconnect ──
  socket.on("disconnect", async () => {
    onlineUsers.delete(socket.id);
    if (dbReady) await q("UPDATE users SET last_seen=now() WHERE id=$1", [userId]).catch(() => {});
    io.emit("presence", Array.from(onlineUsers.values()));
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
initDb()
  .catch(e => console.error("DB init error:", e))
  .finally(() => server.listen(PORT, () => console.log(`Yarchat v5 on port ${PORT}`)));
