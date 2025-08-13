import fs from 'fs';
import path from 'path';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { RateLimiterMemory } from 'rate-limiter-flexible';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import mime from 'mime-types';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// === Config ===
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'change_me_strong_token';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 200);
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 7);
const CLEANUP_INTERVAL_MINUTES = Number(process.env.CLEANUP_INTERVAL_MINUTES || 60);
const ALLOWED_MIME = (process.env.ALLOWED_MIME || 'image/*,video/*,audio/*,application/pdf')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Paths
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DB_DIR = path.join(__dirname, 'db');
const DB_PATH = path.join(DB_DIR, 'files.db');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

// === DB ===
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    ext TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
`);

const insertFile = db.prepare(`INSERT INTO files (id, filename, ext, mime, size, created_at, expires_at)
  VALUES (@id, @filename, @ext, @mime, @size, @created_at, @expires_at)`);
const getFile = db.prepare('SELECT * FROM files WHERE id = ?');
const deleteFileStmt = db.prepare('DELETE FROM files WHERE id = ?');
const listExpired = db.prepare('SELECT * FROM files WHERE expires_at <= ?');

// === Helpers ===
const randomId = (len = 10) => crypto.randomBytes(len).toString('hex');

function isMimeAllowed(m) {
  // Supports wildcards: image/*, video/*, etc.
  return ALLOWED_MIME.some(rule => {
    if (rule.endsWith('/*')) return m.startsWith(rule.slice(0, -1));
    return m === rule;
  });
}

function safeUnlink(p) { try { fs.unlinkSync(p); } catch (_) {} }

// === Rate Limit ===
const rl = new RateLimiterMemory({ points: 30, duration: 60 }); // 30 req/min/IP
async function rateLimitMiddleware(req, res, next) {
  try {
    await rl.consume(req.ip);
    next();
  } catch {
    res.status(429).json({ error: 'Too many requests' });
  }
}

// === Auth ===
function requireToken(req, res, next) {
  const token = req.get('X-API-Key');
  if (!token || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// === Multer ===
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = (mime.extension(file.mimetype) || path.extname(file.originalname).slice(1) || 'bin').toLowerCase();
    const id = randomId(6);
    cb(null, `${id}.${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!isMimeAllowed(file.mimetype)) {
      return cb(new Error('Blocked MIME type'));
    }
    cb(null, true);
  }
});

// === App ===
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(morgan('combined'));
app.use(rateLimitMiddleware);

// Health
app.get('/health', (_req, res) => res.json({ ok: true }));

// Upload endpoint
app.post('/upload', requireToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const now = Date.now();
  const retentionSeconds = Number(req.body.expire_in_seconds) || (RETENTION_DAYS * 86400);
  const expiresAt = now + (retentionSeconds * 1000);

  const { filename, mimetype, size } = req.file;
  const ext = path.extname(filename).slice(1);
  const id = path.basename(filename, `.${ext}`);

  insertFile.run({
    id,
    filename,
    ext,
    mime: mimetype,
    size,
    created_at: now,
    expires_at: expiresAt
  });

  const url = `${BASE_URL}/${filename}`;
  res.json({ url, id, filename, mime: mimetype, size, expires_at: new Date(expiresAt).toISOString() });
});

// Static file serving (no directory listing)
app.use(express.static(UPLOAD_DIR, { index: false, dotfiles: 'deny' }));

// Delete by id (admin)
app.delete('/delete/:id', requireToken, (req, res) => {
  const id = req.params.id;
  const row = getFile.get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  safeUnlink(path.join(UPLOAD_DIR, row.filename));
  deleteFileStmt.run(id);
  res.json({ ok: true, deleted: row.filename });
});

// Cleanup task
function cleanupExpired() {
  const now = Date.now();
  const expired = listExpired.all(now);
  for (const row of expired) {
    safeUnlink(path.join(UPLOAD_DIR, row.filename));
    deleteFileStmt.run(row.id);
  }
  if (expired.length) console.log(`Cleanup: deleted ${expired.length} expired file(s).`);
}
setInterval(cleanupExpired, CLEANUP_INTERVAL_MINUTES * 60 * 1000);
cleanupExpired(); // run once at boot

app.listen(PORT, () => {
  console.log(`BMB URL Uploader API running on port ${PORT}`);
  console.log(`Base URL: ${BASE_URL}`);
});
