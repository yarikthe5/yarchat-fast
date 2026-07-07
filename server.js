import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pkg from "pg";
import bcrypt from "bcryptjs";
import webpush from "web-push";
import { v4 as uuidv4 } from "uuid";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 8000,
  maxHttpBufferSize: 80e6,
  transports: ["websocket", "polling"],
});
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ─── DB ──────────────────────────────────────────────────────────────
let pool = null, dbReady = false;

async function initDb() {
  if (!process.env.DATABASE_URL) { console.log("No DATABASE_URL – memory mode"); return; }
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 10 });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT);

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      password_hash TEXT NOT NULL,
      bio TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT now(),
      last_seen TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chats (
      id SERIAL PRIMARY KEY,
      name TEXT,
      type TEXT NOT NULL DEFAULT 'group',
      avatar TEXT DEFAULT '',
      created_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS chat_members (
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      joined_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chat_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      client_id TEXT UNIQUE,
      chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT,
      file_url TEXT,
      reply_to INTEGER REFERENCES messages(id),
      edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      emoji TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (message_id, user_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS sticker_packs (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      creator_id INTEGER REFERENCES users(id),
      is_public BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS stickers (
      id SERIAL PRIMARY KEY,
      pack_id INTEGER REFERENCES sticker_packs(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      emoji TEXT DEFAULT '⭐',
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      subscription JSONB NOT NULL,
      endpoint TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS map_markers (
      id SERIAL PRIMARY KEY,
      chat_id INTEGER REFERENCES chats(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id),
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      title TEXT DEFAULT 'Зустріч',
      meeting_time TIMESTAMPTZ,
      color TEXT DEFAULT '#7c3aed',
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // Ensure general chat
  await pool.query(`
    INSERT INTO chats (id, name, type) VALUES (1, 'Загальний чат', 'group')
    ON CONFLICT (id) DO NOTHING;
    SELECT setval('chats_id_seq', GREATEST((SELECT MAX(id) FROM chats), 1));
  `);

  dbReady = true;
  console.log("DB ready");
  await initVapid();
}

// ─── VAPID ───────────────────────────────────────────────────────────
let vapidPublicKey = "";
async function initVapid() {
  let keys;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  } else {
    const row = dbReady ? (await pool.query("SELECT value FROM config WHERE key='vapid'")).rows[0] : null;
    if (row) { keys = JSON.parse(row.value); }
    else {
      keys = webpush.generateVAPIDKeys();
      if (dbReady) await pool.query("INSERT INTO config VALUES ('vapid',$1) ON CONFLICT (key) DO NOTHING", [JSON.stringify(keys)]);
    }
  }
  vapidPublicKey = keys.publicKey;
  webpush.setVapidDetails("mailto:admin@yarchat.app", keys.publicKey, keys.privateKey);
}

// ─── AUTH HELPERS ────────────────────────────────────────────────────
const memUsers = new Map();   // username → user
const memSessions = new Map(); // token → user
let memUid = 1;

async function findUserByToken(token) {
  if (!token) return null;
  if (dbReady) {
    const r = await pool.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=$1`, [token]);
    return r.rows[0] || null;
  }
  return memSessions.get(token) || null;
}

async function authMw(req, res, next) {
  const token = req.headers.authorization?.replace("Bearer ", "");
  const user = await findUserByToken(token);
  if (!user) return res.status(401).json({ error: "Unauthorized" });
  req.user = user;
  next();
}

// ─── UPLOAD ──────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, UPLOAD_DIR),
    filename: (_, file, cb) => {
      const ext = path.extname(file.originalname) || "";
      cb(null, `${Date.now()}_${uuidv4().slice(0,8)}${ext}`);
    },
  }),
  // No size limit – client compresses adaptively
});

// ─── EXPRESS ROUTES ──────────────────────────────────────────────────
app.use(express.json({ limit: "4mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Auth
app.post("/api/register", async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password || username.length < 3 || password.length < 4)
      return res.status(400).json({ error: "Ім'я 3+ символи, пароль 4+" });
    const hash = await bcrypt.hash(password, 10);
    const dn = displayName || username;
    if (dbReady) {
      const r = await pool.query(
        `INSERT INTO users (username, display_name, password_hash) VALUES ($1,$2,$3) RETURNING *`,
        [username.toLowerCase(), dn, hash]).catch(() => null);
      if (!r) return res.status(409).json({ error: "Такий username вже зайнятий" });
      const token = uuidv4();
      await pool.query(`INSERT INTO sessions (token, user_id) VALUES ($1,$2)`, [token, r.rows[0].id]);
      return res.json({ token, user: sanitize(r.rows[0]) });
    } else {
      if (memUsers.has(username.toLowerCase())) return res.status(409).json({ error: "Зайнятий" });
      const user = { id: memUid++, username: username.toLowerCase(), display_name: dn, avatar: "", bio: "", password_hash: hash };
      memUsers.set(user.username, user);
      const token = uuidv4();
      memSessions.set(token, user);
      return res.json({ token, user: sanitize(user) });
    }
  } catch (e) { console.error(e); res.status(500).json({ error: "Server error" }); }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    let user;
    if (dbReady) {
      const r = await pool.query(`SELECT * FROM users WHERE username=$1`, [username.toLowerCase()]);
      user = r.rows[0];
    } else { user = memUsers.get(username.toLowerCase()); }
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Неправильний логін або пароль" });
    const token = uuidv4();
    if (dbReady) await pool.query(`INSERT INTO sessions (token, user_id) VALUES ($1,$2)`, [token, user.id]);
    else memSessions.set(token, user);
    res.json({ token, user: sanitize(user) });
  } catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.get("/api/me", authMw, async (req, res) => {
  const chats = await getUserChats(req.user.id);
  res.json({ user: sanitize(req.user), chats });
});

app.put("/api/me", authMw, async (req, res) => {
  const { displayName, bio, avatar } = req.body;
  if (dbReady) {
    const r = await pool.query(
      `UPDATE users SET display_name=COALESCE($1,display_name), bio=COALESCE($2,bio), avatar=COALESCE($3,avatar)
       WHERE id=$4 RETURNING *`, [displayName, bio, avatar, req.user.id]);
    res.json(sanitize(r.rows[0]));
  } else {
    if (displayName) req.user.display_name = displayName;
    if (bio !== undefined) req.user.bio = bio;
    if (avatar) req.user.avatar = avatar;
    res.json(sanitize(req.user));
  }
  io.emit("user-updated", { id: req.user.id, displayName, bio, avatar });
});

// Users search
app.get("/api/users/search", authMw, async (req, res) => {
  const q = (req.query.q || "").toLowerCase().trim();
  if (!q) return res.json([]);
  if (dbReady) {
    const r = await pool.query(
      `SELECT id, username, display_name, avatar FROM users WHERE username ILIKE $1 LIMIT 10`,
      [`%${q}%`]);
    res.json(r.rows);
  } else {
    res.json([...memUsers.values()].filter(u => u.username.includes(q)).slice(0,10).map(sanitize));
  }
});

// Chats
app.get("/api/chats", authMw, async (req, res) => {
  res.json(await getUserChats(req.user.id));
});

app.post("/api/chats", authMw, async (req, res) => {
  const { name, type, userId } = req.body; // type=private: userId=other user; type=group: name
  if (!dbReady) return res.json({ id: 1, name: "General", type: "group" });
  if (type === "private") {
    // Find existing private chat between the two
    const existing = await pool.query(`
      SELECT c.* FROM chats c
      JOIN chat_members m1 ON m1.chat_id=c.id AND m1.user_id=$1
      JOIN chat_members m2 ON m2.chat_id=c.id AND m2.user_id=$2
      WHERE c.type='private' LIMIT 1`, [req.user.id, userId]);
    if (existing.rows.length) return res.json(existing.rows[0]);
    const chat = (await pool.query(`INSERT INTO chats (type, created_by) VALUES ('private',$1) RETURNING *`, [req.user.id])).rows[0];
    await pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING`, [chat.id, req.user.id, userId]);
    return res.json(chat);
  } else {
    const chat = (await pool.query(`INSERT INTO chats (name, type, created_by) VALUES ($1,'group',$2) RETURNING *`, [name || "Новий чат", req.user.id])).rows[0];
    await pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [chat.id, req.user.id]);
    return res.json(chat);
  }
});

app.post("/api/chats/:id/members", authMw, async (req, res) => {
  if (!dbReady) return res.json({ ok: true });
  await pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [req.params.id, req.body.userId]);
  res.json({ ok: true });
});

// Messages history
app.get("/api/chats/:id/messages", authMw, async (req, res) => {
  const chatId = parseInt(req.params.id);
  const limit = parseInt(req.query.limit) || 60;
  const before = req.query.before;
  if (!dbReady) return res.json([]);
  let q = `SELECT m.*, u.username, u.display_name, u.avatar,
    (SELECT json_agg(json_build_object('emoji',r.emoji,'user_id',r.user_id)) FROM reactions r WHERE r.message_id=m.id) as reactions
    FROM messages m LEFT JOIN users u ON u.id=m.user_id
    WHERE m.chat_id=$1 AND m.deleted_at IS NULL`;
  const params = [chatId];
  if (before) { q += ` AND m.id < $${params.length+1}`; params.push(before); }
  q += ` ORDER BY m.id DESC LIMIT $${params.length+1}`;
  params.push(limit);
  const r = await pool.query(q, params);
  res.json(r.rows.reverse());
});

// File upload
app.post("/upload", authMw, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = `/uploads/${req.file.filename}`;
  res.json({ url });
});

// Stickers
app.get("/api/stickers", authMw, async (req, res) => {
  if (!dbReady) return res.json([]);
  const r = await pool.query(`
    SELECT sp.id as pack_id, sp.name as pack_name, sp.creator_id,
           json_agg(json_build_object('id',s.id,'url',s.url,'emoji',s.emoji) ORDER BY s.id) as stickers
    FROM sticker_packs sp JOIN stickers s ON s.pack_id=sp.id
    WHERE sp.is_public=true OR sp.creator_id=$1
    GROUP BY sp.id ORDER BY sp.id`, [req.user.id]);
  res.json(r.rows);
});

app.post("/api/stickers/pack", authMw, async (req, res) => {
  if (!dbReady) return res.json({ id: 1, name: req.body.name });
  const r = await pool.query(`INSERT INTO sticker_packs (name, creator_id) VALUES ($1,$2) RETURNING *`, [req.body.name, req.user.id]);
  res.json(r.rows[0]);
});

app.post("/api/stickers/pack/:id/add", authMw, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const url = `/uploads/${req.file.filename}`;
  if (dbReady) {
    const r = await pool.query(`INSERT INTO stickers (pack_id, url, emoji) VALUES ($1,$2,$3) RETURNING *`, [req.params.id, url, req.body.emoji || "⭐"]);
    res.json(r.rows[0]);
  } else { res.json({ id: 1, url, emoji: req.body.emoji }); }
});

// Push
app.get("/api/push/key", (req, res) => res.json({ publicKey: vapidPublicKey }));
app.post("/api/push/subscribe", authMw, async (req, res) => {
  const sub = req.body.subscription;
  if (!sub || !dbReady) return res.json({ ok: true });
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, subscription, endpoint) VALUES ($1,$2,$3)
     ON CONFLICT (endpoint) DO UPDATE SET subscription=$2, user_id=$1`,
    [req.user.id, JSON.stringify(sub), sub.endpoint]);
  res.json({ ok: true });
});

// Map
app.get("/api/map/:chatId", authMw, async (req, res) => {
  if (!dbReady) return res.json([]);
  const r = await pool.query(
    `SELECT m.*, u.display_name, u.avatar FROM map_markers m LEFT JOIN users u ON u.id=m.user_id
     WHERE m.chat_id=$1 ORDER BY m.created_at DESC LIMIT 50`, [req.params.chatId]);
  res.json(r.rows);
});

app.delete("/api/map/:markerId", authMw, async (req, res) => {
  if (dbReady) await pool.query(`DELETE FROM map_markers WHERE id=$1 AND user_id=$2`, [req.params.markerId, req.user.id]);
  res.json({ ok: true });
});

app.get("/health", (_, res) => res.json({ ok: true, db: dbReady }));

// ─── HELPERS ─────────────────────────────────────────────────────────
function sanitize(u) {
  if (!u) return null;
  const { password_hash, ...safe } = u;
  return safe;
}

async function getUserChats(userId) {
  if (!dbReady) return [{ id: 1, name: "Загальний чат", type: "group", avatar: "", unread: 0 }];
  const r = await pool.query(`
    SELECT c.*, cm.joined_at,
      (SELECT m.content FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_content,
      (SELECT m.type FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_type,
      (SELECT m.created_at FROM messages m WHERE m.chat_id=c.id AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT 1) as last_time
    FROM chats c JOIN chat_members cm ON cm.chat_id=c.id
    WHERE cm.user_id=$1 ORDER BY last_time DESC NULLS LAST`, [userId]);

  // For private chats, get the other user's info
  const chats = [];
  for (const row of r.rows) {
    if (row.type === "private") {
      const other = await pool.query(
        `SELECT u.id, u.username, u.display_name, u.avatar FROM chat_members cm JOIN users u ON u.id=cm.user_id
         WHERE cm.chat_id=$1 AND cm.user_id!=$2 LIMIT 1`, [row.id, userId]);
      if (other.rows[0]) { row.name = other.rows[0].display_name; row.avatar = other.rows[0].avatar; row.other_user = other.rows[0]; }
    }
    chats.push(row);
  }
  // Ensure general chat is included
  if (!chats.find(c => c.id === 1)) {
    await pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES (1,$1) ON CONFLICT DO NOTHING`, [userId]);
    chats.unshift({ id: 1, name: "Загальний чат", type: "group", avatar: "", last_content: null, last_time: null });
  }
  return chats;
}

async function sendPushToUser(userId, title, body) {
  if (!dbReady || !vapidPublicKey) return;
  const subs = await pool.query(`SELECT subscription FROM push_subscriptions WHERE user_id=$1`, [userId]);
  for (const row of subs.rows) {
    try {
      await webpush.sendNotification(JSON.parse(row.subscription), JSON.stringify({ title, body }));
    } catch (e) {
      if (e.statusCode === 410) await pool.query(`DELETE FROM push_subscriptions WHERE subscription=$1::jsonb`, [row.subscription]);
    }
  }
}

// ─── SOCKET.IO ───────────────────────────────────────────────────────
const onlineSockets = new Map(); // socket.id → {userId, chatRooms}

io.on("connection", (socket) => {

  socket.on("auth", async ({ token }, cb) => {
    const user = await findUserByToken(token);
    if (!user) return cb?.({ error: "Invalid token" });
    socket.data.user = sanitize(user);
    socket.data.userId = user.id;
    onlineSockets.set(socket.id, { userId: user.id, username: user.username });

    // Auto-join general chat
    socket.join(`chat:1`);

    if (dbReady) {
      await pool.query(`UPDATE users SET last_seen=now() WHERE id=$1`, [user.id]);
      // Join all user's chats
      const r = await pool.query(`SELECT chat_id FROM chat_members WHERE user_id=$1`, [user.id]);
      for (const row of r.rows) socket.join(`chat:${row.chat_id}`);
    }

    const chats = await getUserChats(user.id);
    cb?.({ ok: true, user: sanitize(user), chats });
    io.emit("presence", { userId: user.id, online: true });
  });

  socket.on("join-chat", (chatId) => socket.join(`chat:${chatId}`));

  socket.on("message", async (data, ack) => {
    const user = socket.data.user;
    if (!user) return ack?.({ error: "Not authed" });
    const { clientId, chatId, type, content, fileUrl, replyTo } = data;
    try {
      let saved;
      if (dbReady) {
        const r = await pool.query(
          `INSERT INTO messages (client_id, chat_id, user_id, type, content, file_url, reply_to)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [clientId, chatId || 1, user.id, type || "text", content, fileUrl, replyTo || null]);
        saved = { ...r.rows[0], username: user.username, display_name: user.display_name, avatar: user.avatar, reactions: [] };
      } else {
        saved = { id: Date.now(), client_id: clientId, chat_id: chatId || 1, user_id: user.id,
          type: type || "text", content, file_url: fileUrl, created_at: new Date().toISOString(),
          username: user.username, display_name: user.display_name || user.username, avatar: user.avatar, reactions: [] };
      }
      io.to(`chat:${chatId || 1}`).emit("message", saved);
      ack?.({ ok: true, id: saved.id, clientId });

      // Push to offline members
      if (dbReady && type === "text") {
        const members = await pool.query(`SELECT user_id FROM chat_members WHERE chat_id=$1 AND user_id!=$2`, [chatId || 1, user.id]);
        const onlineIds = new Set([...onlineSockets.values()].map(s => s.userId));
        for (const m of members.rows) {
          if (!onlineIds.has(m.user_id)) {
            sendPushToUser(m.user_id, user.display_name || user.username, content?.slice(0, 80) || "📎 Медіа");
          }
        }
      }
    } catch (e) { console.error(e); ack?.({ error: "Failed" }); }
  });

  socket.on("typing", ({ chatId, isTyping }) => {
    const u = socket.data.user;
    if (!u) return;
    socket.to(`chat:${chatId || 1}`).emit("typing", { userId: u.id, displayName: u.display_name, chatId, isTyping });
  });

  socket.on("reaction", async ({ messageId, emoji }) => {
    const user = socket.data.user;
    if (!user || !dbReady) return;
    // Toggle reaction
    const exists = await pool.query(`SELECT 1 FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`, [messageId, user.id, emoji]);
    if (exists.rows.length) {
      await pool.query(`DELETE FROM reactions WHERE message_id=$1 AND user_id=$2 AND emoji=$3`, [messageId, user.id, emoji]);
    } else {
      await pool.query(`INSERT INTO reactions (message_id, user_id, emoji) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [messageId, user.id, emoji]);
    }
    const r = await pool.query(`SELECT emoji, json_agg(user_id) as users FROM reactions WHERE message_id=$1 GROUP BY emoji`, [messageId]);
    // Find chat for this message
    const chatRow = dbReady ? await pool.query(`SELECT chat_id FROM messages WHERE id=$1`, [messageId]) : null;
    const chatId = chatRow?.rows[0]?.chat_id || 1;
    io.to(`chat:${chatId}`).emit("reaction-update", { messageId, reactions: r.rows });
  });

  socket.on("edit-message", async ({ messageId, content }) => {
    const user = socket.data.user;
    if (!user || !dbReady) return;
    const r = await pool.query(
      `UPDATE messages SET content=$1, edited_at=now() WHERE id=$2 AND user_id=$3 RETURNING chat_id`,
      [content, messageId, user.id]);
    if (r.rows[0]) io.to(`chat:${r.rows[0].chat_id}`).emit("message-edited", { messageId, content });
  });

  socket.on("delete-message", async ({ messageId }) => {
    const user = socket.data.user;
    if (!user || !dbReady) return;
    const r = await pool.query(
      `UPDATE messages SET deleted_at=now() WHERE id=$1 AND user_id=$2 RETURNING chat_id`,
      [messageId, user.id]);
    if (r.rows[0]) io.to(`chat:${r.rows[0].chat_id}`).emit("message-deleted", { messageId });
  });

  socket.on("map-marker", async ({ chatId, lat, lng, title, meetingTime, color }) => {
    const user = socket.data.user;
    if (!user) return;
    let marker = { chatId, lat, lng, title, meeting_time: meetingTime, color, display_name: user.display_name, avatar: user.avatar };
    if (dbReady) {
      const r = await pool.query(
        `INSERT INTO map_markers (chat_id, user_id, lat, lng, title, meeting_time, color) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [chatId, user.id, lat, lng, title, meetingTime || null, color || "#7c3aed"]);
      marker.id = r.rows[0].id;
    }
    io.to(`chat:${chatId}`).emit("map-marker", marker);
  });

  socket.on("map-draw", ({ chatId, paths }) => {
    socket.to(`chat:${chatId}`).emit("map-draw", { paths, userId: socket.data.userId });
  });

  socket.on("map-marker-delete", async ({ chatId, markerId }) => {
    if (dbReady) await pool.query(`DELETE FROM map_markers WHERE id=$1 AND user_id=$2`, [markerId, socket.data.userId]);
    io.to(`chat:${chatId}`).emit("map-marker-deleted", { markerId });
  });

  socket.on("ping-check", (cb) => { if (typeof cb === "function") cb(Date.now()); });

  socket.on("disconnect", () => {
    const info = onlineSockets.get(socket.id);
    onlineSockets.delete(socket.id);
    if (info) io.emit("presence", { userId: info.userId, online: false });
  });
});

// ─── START ───────────────────────────────────────────────────────────
initDb().catch(e => console.error("DB init:", e)).finally(() => {
  server.listen(PORT, () => console.log(`Yarchat v5 on :${PORT}`));
});
