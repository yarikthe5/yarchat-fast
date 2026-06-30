import express from "express";
import http from "http";
import { Server } from "socket.io";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 10000,
  pingTimeout: 8000,
});

const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, "public", "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- DB (Postgres, опційно через DATABASE_URL з Neon) ----------
let pool = null;
let dbReady = false;

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL не задано — працюю в режимі пам'яті (історія не зберігається між рестартами).");
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      client_id TEXT,
      room TEXT NOT NULL DEFAULT 'general',
      username TEXT NOT NULL,
      avatar TEXT,
      type TEXT NOT NULL DEFAULT 'text',
      content TEXT,
      file_url TEXT,
      reply_to INTEGER,
      reactions JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      avatar TEXT,
      last_seen TIMESTAMPTZ DEFAULT now()
    );
  `);
  dbReady = true;
  console.log("Postgres підключено, таблиці готові.");
}

// ---------- In-memory fallback ----------
const memMessages = [];
let memId = 1;

async function saveMessage(msg) {
  if (dbReady) {
    const res = await pool.query(
      `INSERT INTO messages (client_id, room, username, avatar, type, content, file_url, reply_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [msg.clientId, msg.room || "general", msg.username, msg.avatar, msg.type, msg.content, msg.fileUrl, msg.replyTo || null]
    );
    return { ...msg, id: res.rows[0].id, createdAt: res.rows[0].created_at };
  } else {
    const stored = { ...msg, id: memId++, createdAt: new Date().toISOString() };
    memMessages.push(stored);
    if (memMessages.length > 500) memMessages.shift();
    return stored;
  }
}

async function getHistory(room = "general", limit = 50) {
  if (dbReady) {
    const res = await pool.query(
      `SELECT id, client_id as "clientId", room, username, avatar, type, content, file_url as "fileUrl",
              reply_to as "replyTo", reactions, created_at as "createdAt"
       FROM messages WHERE room = $1 ORDER BY id DESC LIMIT $2`,
      [room, limit]
    );
    return res.rows.reverse();
  }
  return memMessages.slice(-limit);
}

async function addReaction(messageId, emoji, username) {
  if (!dbReady) {
    const m = memMessages.find((x) => x.id === messageId);
    if (!m) return null;
    m.reactions = m.reactions || {};
    m.reactions[emoji] = m.reactions[emoji] || [];
    if (!m.reactions[emoji].includes(username)) m.reactions[emoji].push(username);
    return m.reactions;
  }
  const res = await pool.query(`SELECT reactions FROM messages WHERE id=$1`, [messageId]);
  if (!res.rows.length) return null;
  const reactions = res.rows[0].reactions || {};
  reactions[emoji] = reactions[emoji] || [];
  if (!reactions[emoji].includes(username)) reactions[emoji].push(username);
  await pool.query(`UPDATE messages SET reactions=$1 WHERE id=$2`, [JSON.stringify(reactions), messageId]);
  return reactions;
}

// ---------- Static + uploads ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || "";
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/upload", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  res.json({ url: `/uploads/${req.file.filename}` });
});

app.get("/api/history", async (req, res) => {
  const room = req.query.room || "general";
  res.json(await getHistory(room));
});

app.get("/health", (req, res) => res.json({ ok: true, db: dbReady }));

// ---------- Socket.IO ----------
const onlineUsers = new Map(); // socket.id -> {username, avatar}

io.on("connection", (socket) => {
  socket.on("join", async ({ username, avatar }) => {
    socket.data.username = username;
    socket.data.avatar = avatar;
    onlineUsers.set(socket.id, { username, avatar });
    socket.join("general");

    if (dbReady) {
      await pool.query(
        `INSERT INTO users (username, avatar, last_seen) VALUES ($1,$2,now())
         ON CONFLICT (username) DO UPDATE SET avatar=$2, last_seen=now()`,
        [username, avatar]
      );
    }

    const history = await getHistory("general", 50);
    socket.emit("history", history);
    io.emit("presence", Array.from(onlineUsers.values()));
    socket.to("general").emit("system", { text: `${username} приєднався(лась)` });
  });

  socket.on("message", async (data, ack) => {
    const { clientId, type, content, fileUrl, replyTo, room } = data;
    const username = socket.data.username || "Гість";
    const avatar = socket.data.avatar || "";
    try {
      const saved = await saveMessage({ clientId, room, username, avatar, type, content, fileUrl, replyTo });
      io.to(room || "general").emit("message", saved);
      if (typeof ack === "function") ack({ ok: true, id: saved.id, clientId });
    } catch (e) {
      console.error(e);
      if (typeof ack === "function") ack({ ok: false, clientId });
    }
  });

  socket.on("typing", ({ username, isTyping }) => {
    socket.to("general").emit("typing", { username, isTyping });
  });

  socket.on("reaction", async ({ messageId, emoji, username }) => {
    const reactions = await addReaction(messageId, emoji, username);
    if (reactions) io.to("general").emit("reaction-update", { messageId, reactions });
  });

  socket.on("ping-check", (cb) => {
    if (typeof cb === "function") cb(Date.now());
  });

  socket.on("disconnect", () => {
    const u = onlineUsers.get(socket.id);
    onlineUsers.delete(socket.id);
    io.emit("presence", Array.from(onlineUsers.values()));
    if (u) socket.to("general").emit("system", { text: `${u.username} вийшов(шла)` });
  });
});

initDb()
  .catch((e) => console.error("DB init error:", e))
  .finally(() => {
    server.listen(PORT, () => console.log(`Yarchat запущено на порту ${PORT}`));
  });
