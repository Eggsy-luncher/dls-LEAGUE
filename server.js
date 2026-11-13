require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const nodemailer = require('nodemailer');
const db = require('./db');
const storage = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-this-before-production';
const ADMIN_EMAIL = String(process.env.DLS_ADMIN_EMAIL || 'ossommordecai@gmail.com').trim().toLowerCase();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true';
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const SMTP_FROM = String(process.env.SMTP_FROM || '').trim();
const PUBLIC_URL = String(process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
const emailConfigured = Boolean(SMTP_HOST && Number.isInteger(SMTP_PORT) && SMTP_PORT > 0 && SMTP_PORT <= 65535 &&
  SMTP_FROM && Boolean(SMTP_USER) === Boolean(SMTP_PASS) && (!IS_PRODUCTION || PUBLIC_URL.startsWith('https://')));
const mailer = emailConfigured ? nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE,
  requireTLS: IS_PRODUCTION && !SMTP_SECURE,
  connectionTimeout: 10000,
  greetingTimeout: 10000,
  socketTimeout: 15000,
  ...(SMTP_USER ? { auth: { user: SMTP_USER, pass: SMTP_PASS } } : {})
}) : null;

if (IS_PRODUCTION && JWT_SECRET === 'development-only-change-this-before-production') {
  throw new Error('Set a strong JWT_SECRET before running in production.');
}

const databaseReady = Promise.all([db.initialize(), storage.initialize()]);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '128kb' }));
app.use(cookieParser());
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use((_req, res, next) => {
  databaseReady.then(() => next()).catch(next);
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    const accepted = new Set(['image/jpeg', 'image/png', 'image/webp']);
    callback(accepted.has(file.mimetype) ? null : new Error('Upload a JPEG, PNG, or WebP screenshot.'), accepted.has(file.mimetype));
  }
});

const attempts = new Map();
function rateLimitAuth(req, res, next) {
  const key = `${req.ip}:${req.path}`;
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || now - record.startedAt > 15 * 60 * 1000) {
    attempts.set(key, { startedAt: now, count: 1 });
    return next();
  }
  if (record.count >= 12) return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  record.count += 1;
  next();
}
function issueToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: '7d', issuer: 'dls26-arena' });
}
function setSessionCookie(res, token) {
  res.cookie('dls26_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: IS_PRODUCTION,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}
async function currentUser(req) {
  const bearer = req.get('authorization');
  const token = bearer?.startsWith('Bearer ') ? bearer.slice(7) : req.cookies.dls26_session;
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { issuer: 'dls26-arena' });
  } catch {
    return null;
  }
  return await db.prepare('SELECT id,email,display_name,gamer_tag,points,role FROM users WHERE id=? AND email_verified=1').get(Number(payload.sub)) || null;
}
function authenticate(req, res, next) {
  currentUser(req).then(user => {
    if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
    req.user = user;
    next();
  }).catch(next);
}
function requireAdmin(req, res, next) {
  if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only the configured tournament organizer can do that.' });
  next();
}
function isAdmin(user) {
  return user?.role === 'admin';
}
function hashVerificationToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}
async function createVerificationToken(record) {
  const token = crypto.randomBytes(32).toString('hex');
  await db.prepare(`INSERT INTO pending_verifications (email,password_hash,display_name,gamer_tag,token_hash,expires_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(email) DO UPDATE SET password_hash=excluded.password_hash,display_name=excluded.display_name,
      gamer_tag=excluded.gamer_tag,token_hash=excluded.token_hash,expires_at=excluded.expires_at,created_at=CURRENT_TIMESTAMP`)
    .run(record.email, record.passwordHash, record.displayName, record.gamerTag, hashVerificationToken(token),
      new Date(Date.now() + 30 * 60 * 1000).toISOString());
  return token;
}
async function sendVerificationEmail(email, token) {
  if (!mailer) throw new Error('Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_FROM, and matching SMTP credentials in .env.');
  const verificationUrl = `${PUBLIC_URL}/?verify=${encodeURIComponent(token)}`;
  await mailer.sendMail({
    from: SMTP_FROM,
    to: email,
    subject: 'Verify your DLS 26 Arena email',
    text: `Verify your email address to activate your DLS 26 Arena account:\n\n${verificationUrl}\n\nThis link expires in 30 minutes. If you did not sign up, ignore this message.`,
    html: `<p>Verify your email address to activate your DLS 26 Arena account:</p><p><a href="${verificationUrl}">Verify email address</a></p><p>This link expires in 30 minutes. If you did not sign up, ignore this message.</p>`
  });
}
function validIsoDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
function imageHasValidSignature(buffer, mimeType) {
  if (mimeType === 'image/png') return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
  if (mimeType === 'image/webp') return buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
  return false;
}
async function refreshStandings(tournamentId) {
  const players = await db.prepare(`SELECT u.id,u.gamer_tag AS gamerTag FROM tournament_players tp JOIN users u ON u.id=tp.user_id WHERE tp.tournament_id=?`).all(tournamentId);
  const completed = await db.prepare(`SELECT home_user_id,away_user_id,home_score,away_score FROM matches WHERE tournament_id=? AND status='completed'`).all(tournamentId);
  const table = new Map(players.map(({ id }) => [id, { played: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, points: 0 }]));
  for (const match of completed) {
    const home = table.get(match.home_user_id);
    const away = table.get(match.away_user_id);
    if (!home || !away) continue;
    home.played += 1;
    away.played += 1;
    home.goalsFor += match.home_score;
    home.goalsAgainst += match.away_score;
    away.goalsFor += match.away_score;
    away.goalsAgainst += match.home_score;
    if (match.home_score > match.away_score) { home.wins++; home.points += 3; away.losses++; }
    else if (match.home_score < match.away_score) { away.wins++; away.points += 3; home.losses++; }
    else { home.draws++; away.draws++; home.points++; away.points++; }
  }
  const gamerTags = new Map(players.map(player => [player.id, player.gamerTag]));
  return [...table.entries()].map(([userId, stats]) => ({ userId, gamerTag: gamerTags.get(userId), ...stats }))
    .sort((a, b) => b.points - a.points || (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) || b.goalsFor - a.goalsFor || a.gamerTag.localeCompare(b.gamerTag));
}
async function groupStageQualifiers(tournamentId) {
  const players = await db.prepare(`SELECT u.id,u.gamer_tag AS gamerTag,tp.group_key AS groupKey
    FROM tournament_players tp JOIN users u ON u.id=tp.user_id
    WHERE tp.tournament_id=? ORDER BY tp.group_key,u.gamer_tag COLLATE NOCASE`).all(tournamentId);
  const groups = new Map();
  for (const player of players) {
    if (!player.groupKey) return null;
    if (!groups.has(player.groupKey)) groups.set(player.groupKey, []);
    groups.get(player.groupKey).push(player);
  }
  if (!groups.size || [...groups.values()].some(group => group.length < 2)) return null;
  const matches = await db.prepare(`SELECT home_user_id,away_user_id,home_score,away_score,status FROM matches
    WHERE tournament_id=? AND stage='group'`).all(tournamentId);
  if (matches.some(match => match.status !== 'completed')) return null;
  const expectedMatches = [...groups.values()].reduce((total, group) => total + group.length * (group.length - 1) / 2, 0);
  if (matches.length !== expectedMatches) return null;
  const stats = new Map(players.map(player => [player.id, { ...player, points: 0, goalsFor: 0, goalsAgainst: 0 }]));
  for (const match of matches) {
    const home = stats.get(match.home_user_id);
    const away = stats.get(match.away_user_id);
    if (!home || !away || home.groupKey !== away.groupKey) return null;
    home.goalsFor += match.home_score;
    home.goalsAgainst += match.away_score;
    away.goalsFor += match.away_score;
    away.goalsAgainst += match.home_score;
    if (match.home_score > match.away_score) home.points += 3;
    else if (match.home_score < match.away_score) away.points += 3;
    else { home.points++; away.points++; }
  }
  return [...groups.values()].flatMap(group => group
    .map(player => stats.get(player.id))
    .sort((a, b) => b.points - a.points ||
      (b.goalsFor - b.goalsAgainst) - (a.goalsFor - a.goalsAgainst) ||
      b.goalsFor - a.goalsFor || a.gamerTag.localeCompare(b.gamerTag))
    .slice(0, 2)
    .map(player => player.id));
}
async function knockoutBracketIsComplete(tournamentId, format) {
  const rounds = await db.prepare(`SELECT id,round_number AS round,home_user_id,away_user_id,home_score,away_score,status
    FROM matches WHERE tournament_id=? AND stage='knockout' ORDER BY round_number,id`).all(tournamentId);
  if (!rounds.length) return false;
  const byRound = new Map();
  for (const match of rounds) {
    if (!byRound.has(match.round)) byRound.set(match.round, []);
    byRound.get(match.round).push(match);
  }
  const roundNumbers = [...byRound.keys()].sort((a, b) => a - b);
  if (roundNumbers[0] !== 1 || byRound.get(roundNumbers[roundNumbers.length - 1]).length !== 1) return false;
  if (roundNumbers.some((round, index) => round !== index + 1)) return false;
  if (format === 'groups_knockout') {
    const qualifiers = await groupStageQualifiers(tournamentId);
    const firstRoundPlayers = byRound.get(1).flatMap(match => [match.home_user_id, match.away_user_id]).sort((a, b) => a - b);
    if (!qualifiers || qualifiers.length < 2 || (qualifiers.length & (qualifiers.length - 1)) !== 0 ||
        [...qualifiers].sort((a, b) => a - b).join(',') !== firstRoundPlayers.join(',')) return false;
  }
  for (let index = 1; index < roundNumbers.length; index++) {
    const previous = byRound.get(roundNumbers[index - 1]);
    const current = byRound.get(roundNumbers[index]);
    if (previous.some(match => match.status !== 'completed') || previous.length !== current.length * 2) return false;
    const winners = previous.map(match => match.home_score > match.away_score ? match.home_user_id : match.away_user_id).sort((a, b) => a - b);
    const entrants = current.flatMap(match => [match.home_user_id, match.away_user_id]).sort((a, b) => a - b);
    if (winners.join(',') !== entrants.join(',')) return false;
  }
  return true;
}
async function maybeFinishTournament(tournamentId) {
  const tournament = await db.prepare("SELECT * FROM tournaments WHERE id=? AND status='open'").get(tournamentId);
  if (!tournament || !tournament.ends_at || Date.parse(tournament.ends_at) > Date.now()) return false;
  const counts = await db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed
    FROM matches WHERE tournament_id=?`).get(tournamentId);
  if (!counts.total || counts.completed !== counts.total) return false;
  const leaderboard = await refreshStandings(tournamentId);
  if (!leaderboard.length) return false;
  let championId = leaderboard[0].userId;
  if (['knockout', 'groups_knockout'].includes(tournament.format)) {
    if (!await knockoutBracketIsComplete(tournamentId, tournament.format)) return false;
    const finalRound = (await db.prepare(`SELECT MAX(round_number) AS round FROM matches
      WHERE tournament_id=? AND stage='knockout'`).get(tournamentId)).round;
    if (finalRound === null) return false;
    const finals = await db.prepare(`SELECT home_user_id,away_user_id,home_score,away_score FROM matches
      WHERE tournament_id=? AND stage='knockout' AND round_number=? AND status='completed'`).all(tournamentId, finalRound);
    if (finals.length !== 1 || finals[0].home_score === finals[0].away_score) return false;
    championId = finals[0].home_score > finals[0].away_score ? finals[0].home_user_id : finals[0].away_user_id;
  }
  const finish = db.transaction(async () => {
    const updated = await db.prepare("UPDATE tournaments SET status='finished',champion_user_id=?,ended_at=CURRENT_TIMESTAMP WHERE id=? AND status='open'").run(championId, tournamentId);
    if (!updated.changes) return false;
    if (tournament.reward_points > 0) await db.prepare('UPDATE users SET points=points+? WHERE id=?').run(tournament.reward_points, championId);
    return true;
  });
  return finish();
}
async function finalizeReadyTournaments() {
  const tournaments = await db.prepare("SELECT id FROM tournaments WHERE status='open' AND ends_at IS NOT NULL AND ends_at<=?").all(new Date().toISOString());
  for (const tournament of tournaments) await maybeFinishTournament(tournament.id);
}
async function settlePredictions(match) {
  const predictions = await db.prepare('SELECT * FROM predictions WHERE match_id=?').all(match.id);
  if (match.home_score === match.away_score) {
    for (const prediction of predictions) {
      await db.prepare('UPDATE users SET points=points+? WHERE id=?').run(prediction.stake, prediction.user_id);
      await db.prepare('UPDATE predictions SET prize=stake,claimed=1 WHERE id=?').run(prediction.id);
    }
    return;
  }
  const winner = match.home_score > match.away_score ? match.home_user_id : match.away_user_id;
  const winningStake = predictions.filter(item => item.picked_user_id === winner).reduce((sum, item) => sum + item.stake, 0);
  const losingStake = predictions.filter(item => item.picked_user_id !== winner).reduce((sum, item) => sum + item.stake, 0);
  for (const prediction of predictions) {
    const prize = prediction.picked_user_id === winner
      ? prediction.stake + (winningStake ? Math.floor(losingStake * prediction.stake / winningStake) : 0)
      : 0;
    await db.prepare('UPDATE predictions SET prize=? WHERE id=?').run(prize, prediction.id);
  }
}
function safeMessage(error) {
  if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(error?.code)) return 'That DLS name, email, or prediction is already in use.';
  if (['SQLITE_CONSTRAINT_PRIMARYKEY', '23503'].includes(error?.code)) return 'This player is already in the tournament.';
  return 'Something went wrong. Please try again.';
}
function jsonHandler(handler) {
  return (req, res, next) => {
    const handleError = error => {
      if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Screenshots must be 5 MB or smaller.' : 'Invalid screenshot upload.' });
      if (error.message?.startsWith('Upload a JPEG')) return res.status(400).json({ error: error.message });
      console.error('[dls26]', error);
      if (!res.headersSent) return res.status(500).json({ error: safeMessage(error) });
      next(error);
    };
    try { Promise.resolve(handler(req, res, next)).catch(handleError); }
    catch (error) { handleError(error); }
  };
}
function uploadScreenshot(req, res, next) {
  upload.single('screenshot')(req, res, error => {
    if (!error) return next();
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Screenshots must be 5 MB or smaller.' : 'Invalid screenshot upload.' });
    res.status(400).json({ error: error.message?.startsWith('Upload a JPEG') ? error.message : 'Could not upload this screenshot.' });
  });
}
function safeSubmission(submission, userId) {
  return {
    id: submission.id,
    matchId: submission.match_id,
    submittedBy: submission.submitted_by,
    submittedByTag: submission.submitted_by_tag,
    homeScore: submission.home_score,
    awayScore: submission.away_score,
    status: submission.status,
    adminNote: submission.admin_note,
    createdAt: submission.created_at,
    screenshotUrl: `/api/submissions/${submission.id}/screenshot`,
    canDispute: submission.status === 'pending' && submission.submitted_by !== userId &&
      (submission.home_user_id === userId || submission.away_user_id === userId)
  };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'dls26-arena' }));
app.get('/api/auth/config', (_req, res) => res.json({ emailConfigured: Boolean(mailer) }));
app.post('/api/auth/register', rateLimitAuth, jsonHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const displayName = String(req.body.displayName || '').trim().replace(/\s+/g, ' ');
  const gamerTag = String(req.body.gamerTag || '').trim().replace(/\s+/g, ' ');
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (displayName.length < 2 || displayName.length > 42) return res.status(400).json({ error: 'Display name must be 2–42 characters.' });
  if (gamerTag.length < 2 || gamerTag.length > 32 || /[<>]/.test(gamerTag)) return res.status(400).json({ error: 'DLS names must be 2–32 characters.' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Passwords must be at least 10 characters.' });
  if (!mailer) return res.status(503).json({ error: 'Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_FROM, and matching SMTP credentials in .env.' });
  if (await db.prepare('SELECT 1 FROM users WHERE email=? COLLATE NOCASE').get(email)) return res.status(409).json({ error: 'An account already uses this email. Sign in or request a verification email.' });
  if (await db.prepare('SELECT 1 FROM users WHERE gamer_tag=? COLLATE NOCASE').get(gamerTag)) return res.status(409).json({ error: 'That DLS name is already in use.' });
  const passwordHash = await bcrypt.hash(password, 12);
  let token;
  try {
    token = await createVerificationToken({ email, passwordHash, displayName, gamerTag });
  } catch (error) {
    if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(error.code)) return res.status(409).json({ error: 'That DLS name is already in use.' });
    throw error;
  }
  try {
    await sendVerificationEmail(email, token);
  } catch (error) {
    console.error('[dls26] Verification email delivery failed:', error);
    return res.status(503).json({ error: 'Could not send the verification email. Check SMTP settings and try again.' });
  }
  res.status(202).json({ verificationRequired: true });
}));
app.post('/api/auth/resend-verification', rateLimitAuth, jsonHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254 || !password) return res.status(400).json({ error: 'Enter the account email and password.' });
  if (!mailer) return res.status(503).json({ error: 'Email verification is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_FROM, and matching SMTP credentials in .env.' });
  const user = await db.prepare('SELECT email,password_hash,display_name,gamer_tag,email_verified FROM users WHERE email=? COLLATE NOCASE').get(email);
  if (user?.email_verified) return res.json({ ok: true });
  const pending = user ? null : await db.prepare('SELECT * FROM pending_verifications WHERE email=? COLLATE NOCASE').get(email);
  const account = user || pending;
  if (!account || !(await bcrypt.compare(password, account.password_hash))) return res.json({ ok: true });
  const record = {
    email: account.email,
    passwordHash: account.password_hash,
    displayName: account.display_name,
    gamerTag: account.gamer_tag
  };
  const token = await createVerificationToken(record);
  try {
    await sendVerificationEmail(email, token);
  } catch (error) {
    console.error('[dls26] Verification email delivery failed:', error);
    return res.status(503).json({ error: 'Could not send the verification email. Check SMTP settings and try again.' });
  }
  res.json({ ok: true });
}));
app.post('/api/auth/verify', jsonHandler(async (req, res) => {
  const token = String(req.body.token || '');
  if (!/^[a-f0-9]{64}$/i.test(token)) return res.status(400).json({ error: 'This verification link is invalid or expired. Request a new email.' });
  const tokenHash = hashVerificationToken(token);
  const pending = await db.prepare('SELECT * FROM pending_verifications WHERE token_hash=?').get(tokenHash);
  if (!pending || Date.parse(pending.expires_at) <= Date.now()) {
    if (pending) await db.prepare('DELETE FROM pending_verifications WHERE email=?').run(pending.email);
    return res.status(400).json({ error: 'This verification link is invalid or expired. Request a new email.' });
  }
  let user;
  try {
    const verify = db.transaction(async () => {
      const existing = await db.prepare('SELECT id,email,email_verified FROM users WHERE email=? COLLATE NOCASE').get(pending.email);
      if (existing?.email_verified) throw new Error('This email address is already verified. Sign in instead.');
      if (existing) {
        await db.prepare(`UPDATE users SET email_verified=1,role=CASE WHEN email=? COLLATE NOCASE THEN 'admin' ELSE role END
          WHERE id=?`).run(ADMIN_EMAIL, existing.id);
        await db.prepare('UPDATE users SET display_name=?,gamer_tag=? WHERE id=?').run(pending.display_name, pending.gamer_tag, existing.id);
        user = await db.prepare('SELECT id,email,display_name,gamer_tag,points,role FROM users WHERE id=?').get(existing.id);
      } else {
        const role = pending.email.toLowerCase() === ADMIN_EMAIL ? 'admin' : 'player';
        const created = await db.prepare(`INSERT INTO users (email,password_hash,display_name,gamer_tag,role,email_verified)
          VALUES (?,?,?,?,?,1)`).run(pending.email, pending.password_hash, pending.display_name, pending.gamer_tag, role);
        user = { id: Number(created.lastInsertRowid), email: pending.email, display_name: pending.display_name,
          gamer_tag: pending.gamer_tag, points: 1000, role };
      }
      await db.prepare('DELETE FROM pending_verifications WHERE email=?').run(pending.email);
    });
    await verify();
  } catch (error) {
    if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(error.code)) return res.status(409).json({ error: 'That DLS name is already in use. Request a new verification email with another name.' });
    if (error.message === 'This email address is already verified. Sign in instead.') return res.status(409).json({ error: error.message });
    throw error;
  }
  setSessionCookie(res, issueToken(user));
  res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, gamerTag: user.gamer_tag, points: user.points, role: user.role } });
}));
app.post('/api/auth/login', rateLimitAuth, jsonHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const user = await db.prepare('SELECT * FROM users WHERE email=?').get(email);
  if (!user) {
    const pending = await db.prepare('SELECT password_hash FROM pending_verifications WHERE email=? COLLATE NOCASE').get(email);
    if (pending && await bcrypt.compare(String(req.body.password || ''), pending.password_hash)) {
      return res.status(403).json({ error: 'Verify your email address before signing in. Use Resend verification to send a new link.' });
    }
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  if (!(await bcrypt.compare(String(req.body.password || ''), user.password_hash))) return res.status(401).json({ error: 'Incorrect email or password.' });
  if (!user.email_verified) return res.status(403).json({ error: 'Verify your email address before signing in. Use Resend verification to send a new link.' });
  attempts.delete(`${req.ip}:${req.path}`);
  const token = issueToken(user);
  setSessionCookie(res, token);
  res.json({ user: { id: user.id, email: user.email, displayName: user.display_name, gamerTag: user.gamer_tag, points: user.points, role: user.role } });
}));
app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('dls26_session', { path: '/' });
  res.status(204).end();
});
app.get('/api/auth/me', authenticate, (req, res) => res.json({
  user: {
    id: req.user.id, email: req.user.email, displayName: req.user.display_name || req.user.displayName,
    gamerTag: req.user.gamer_tag || req.user.gamerTag, points: req.user.points, role: req.user.role
  }
}));

app.get('/api/overview', authenticate, jsonHandler(async (req, res) => {
  await finalizeReadyTournaments();
  const balance = (await db.prepare('SELECT points FROM users WHERE id=?').get(req.user.id)).points;
  const tournaments = await db.prepare(`SELECT t.id,t.name,t.status,t.format,t.starts_at AS startsAt,t.ends_at AS endsAt,
      t.reward_points AS rewardPoints,t.prize_description AS prizeDescription,t.prize_awarded AS prizeAwarded,
      t.prize_awarded_at AS prizeAwardedAt,t.champion_user_id AS championId,t.ended_at AS endedAt,
      (SELECT u.gamer_tag FROM users u WHERE u.id=t.champion_user_id) AS championTag,
      (SELECT COUNT(*) FROM tournament_players p WHERE p.tournament_id=t.id) AS playerCount,
      (SELECT COUNT(*) FROM matches m WHERE m.tournament_id=t.id) AS matchCount
    FROM tournaments t ORDER BY CASE t.status WHEN 'open' THEN 0 ELSE 1 END,t.created_at DESC`).all();
  const selectedId = Number(req.query.tournamentId);
  const tournament = tournaments.find(item => item.id === selectedId) || tournaments.find(item => item.status === 'open') || tournaments[0] || null;
  if (!tournament) return res.json({
    isAdmin: isAdmin(req.user), balance, tournaments, tournament: null,
    players: [], leaderboard: [], matches: [], submissions: []
  });
  const players = await db.prepare(`SELECT u.id AS userId,u.gamer_tag AS gamerTag,p.group_key AS groupKey FROM tournament_players p
    JOIN users u ON u.id=p.user_id WHERE p.tournament_id=? ORDER BY u.gamer_tag COLLATE NOCASE`).all(tournament.id);
  const leaderboard = await refreshStandings(tournament.id);
  const matches = await db.prepare(`SELECT m.id,m.tournament_id AS tournamentId,m.scheduled_at AS scheduledAt,m.deadline_at AS deadlineAt,
      m.stage,m.round_number AS roundNumber,
      m.status,m.home_user_id AS homeUserId,m.away_user_id AS awayUserId,m.home_score AS homeScore,m.away_score AS awayScore,
      h.gamer_tag AS homeTag,a.gamer_tag AS awayTag,
      (SELECT s.id FROM result_submissions s WHERE s.match_id=m.id AND s.status IN ('pending','disputed') ORDER BY s.id DESC LIMIT 1) AS pendingSubmissionId,
      (SELECT s.submitted_by FROM result_submissions s WHERE s.match_id=m.id AND s.status IN ('pending','disputed') ORDER BY s.id DESC LIMIT 1) AS pendingSubmittedBy,
      (SELECT s.home_score FROM result_submissions s WHERE s.match_id=m.id AND s.status IN ('pending','disputed') ORDER BY s.id DESC LIMIT 1) AS pendingHomeScore,
      (SELECT s.away_score FROM result_submissions s WHERE s.match_id=m.id AND s.status IN ('pending','disputed') ORDER BY s.id DESC LIMIT 1) AS pendingAwayScore,
      (SELECT p.picked_user_id FROM predictions p WHERE p.match_id=m.id AND p.user_id=?) AS myPick,
      (SELECT p.prize FROM predictions p WHERE p.match_id=m.id AND p.user_id=?) AS myPrize,
      (SELECT p.claimed FROM predictions p WHERE p.match_id=m.id AND p.user_id=?) AS prizeClaimed
    FROM matches m JOIN users h ON h.id=m.home_user_id JOIN users a ON a.id=m.away_user_id
    WHERE m.tournament_id=? ORDER BY CASE m.status WHEN 'pending_review' THEN 0 WHEN 'scheduled' THEN 1 ELSE 2 END,m.scheduled_at`).all(req.user.id, req.user.id, req.user.id, tournament.id);
  const submissions = (await db.prepare(`SELECT s.*,u.gamer_tag AS submitted_by_tag,m.home_user_id,m.away_user_id FROM result_submissions s
    JOIN users u ON u.id=s.submitted_by JOIN matches m ON m.id=s.match_id
    WHERE m.tournament_id=? AND (s.submitted_by=? OR ?=1 OR s.status IN ('pending','disputed'))
    ORDER BY s.id DESC LIMIT 60`).all(tournament.id, req.user.id, isAdmin(req.user) ? 1 : 0))
    .map(item => safeSubmission(item, req.user.id));
  res.json({ isAdmin: isAdmin(req.user), balance, tournaments, tournament, players, leaderboard, matches, submissions });
}));
app.post('/api/tournaments', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const name = String(req.body.name || '').trim();
  const format = String(req.body.format || 'single_round_robin');
  const rewardPoints = Number(req.body.rewardPoints);
  const prizeDescription = String(req.body.prizeDescription || '').trim();
  if (name.length < 3 || name.length > 60) return res.status(400).json({ error: 'Tournament names must be 3–60 characters.' });
  if (req.body.startsAt && !validIsoDate(req.body.startsAt)) return res.status(400).json({ error: 'Choose a valid tournament start time.' });
  if (!['single_round_robin', 'double_round_robin', 'knockout', 'groups_knockout'].includes(format)) return res.status(400).json({ error: 'Choose a supported league format.' });
  if (!validIsoDate(req.body.endsAt) || (req.body.startsAt && Date.parse(req.body.endsAt) <= Date.parse(req.body.startsAt))) {
    return res.status(400).json({ error: 'Set an end time after the league start time.' });
  }
  if (!Number.isSafeInteger(rewardPoints) || rewardPoints < 0 || rewardPoints > 1000000) return res.status(400).json({ error: 'Champion points must be between 0 and 1,000,000.' });
  if (prizeDescription.length > 120) return res.status(400).json({ error: 'Prize descriptions must be 120 characters or fewer.' });
  const startsAt = req.body.startsAt ? new Date(req.body.startsAt).toISOString() : null;
  const endsAt = new Date(req.body.endsAt).toISOString();
  const result = await db.prepare(`INSERT INTO tournaments (name,format,starts_at,ends_at,reward_points,prize_description)
    VALUES (?,?,?,?,?,?)`).run(name, format, startsAt, endsAt, rewardPoints, prizeDescription);
  res.status(201).json({ tournamentId: Number(result.lastInsertRowid) });
}));
app.post('/api/tournaments/:id/players', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const tournamentId = Number(req.params.id);
  const tournament = await db.prepare("SELECT id,format FROM tournaments WHERE id=? AND status='open'").get(tournamentId);
  if (!tournament) return res.status(404).json({ error: 'Open tournament not found.' });
  const identity = String(req.body.identity || '').trim();
  const groupKey = String(req.body.groupKey || '').trim().toUpperCase();
  if (tournament.format === 'groups_knockout' && !/^[A-H]$/.test(groupKey)) return res.status(400).json({ error: 'Choose a group from A to H for this player.' });
  if (tournament.format !== 'groups_knockout' && groupKey) return res.status(400).json({ error: 'Groups can only be assigned in a group-stage tournament.' });
  const user = await db.prepare('SELECT id,gamer_tag FROM users WHERE email=? COLLATE NOCASE OR gamer_tag=? COLLATE NOCASE').get(identity, identity);
  if (!user) return res.status(404).json({ error: 'Player not found. Ask them to register their DLS name first.' });
  await db.prepare('INSERT INTO tournament_players (tournament_id,user_id,group_key) VALUES (?,?,?)').run(tournamentId, user.id, groupKey);
  res.status(201).json({ ok: true, gamerTag: user.gamer_tag });
}));
app.post('/api/tournaments/:id/matches', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const tournamentId = Number(req.params.id);
  const homeUserId = Number(req.body.homeUserId);
  const awayUserId = Number(req.body.awayUserId);
  const scheduledAt = String(req.body.scheduledAt || '');
  const deadlineAt = String(req.body.deadlineAt || '');
  const stage = String(req.body.stage || 'league');
  const roundNumber = Number(req.body.roundNumber || 1);
  const tournament = await db.prepare("SELECT id,format FROM tournaments WHERE id=? AND status='open'").get(tournamentId);
  if (!tournament) return res.status(404).json({ error: 'Open tournament not found.' });
  if (!Number.isInteger(homeUserId) || !Number.isInteger(awayUserId) || homeUserId === awayUserId ||
      !validIsoDate(scheduledAt) || !validIsoDate(deadlineAt) || Date.parse(deadlineAt) < Date.parse(scheduledAt)) {
    return res.status(400).json({ error: 'Choose two different players and a deadline at or after kick-off.' });
  }
  const members = await db.prepare('SELECT user_id,group_key FROM tournament_players WHERE tournament_id=? AND user_id IN (?,?)').all(tournamentId, homeUserId, awayUserId);
  if (members.length !== 2) return res.status(400).json({ error: 'Add both players to the tournament before scheduling their fixture.' });
  if (!Number.isInteger(roundNumber) || roundNumber < 1 || roundNumber > 16) return res.status(400).json({ error: 'Round number must be between 1 and 16.' });
  if (['single_round_robin', 'double_round_robin'].includes(tournament.format)) {
    if (stage !== 'league') return res.status(400).json({ error: 'Choose the league stage for this format.' });
    const pair = await db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE tournament_id=?
      AND ((home_user_id=? AND away_user_id=?) OR (home_user_id=? AND away_user_id=?))`).get(tournamentId, homeUserId, awayUserId, awayUserId, homeUserId);
    const allowed = tournament.format === 'single_round_robin' ? pair.count === 0 : pair.count < 2;
    if (!allowed) return res.status(409).json({ error: 'That player pairing already has all fixtures required for this league format.' });
    if (tournament.format === 'double_round_robin' && pair.count === 1) {
      const firstLeg = await db.prepare(`SELECT home_user_id,away_user_id FROM matches WHERE tournament_id=?
        AND ((home_user_id=? AND away_user_id=?) OR (home_user_id=? AND away_user_id=?))`).get(tournamentId, homeUserId, awayUserId, awayUserId, homeUserId);
      if (firstLeg.home_user_id === homeUserId) return res.status(409).json({ error: 'The second league fixture must reverse the home and away players.' });
    }
  } else {
    if (!['group', 'knockout'].includes(stage) || (tournament.format === 'knockout' && stage !== 'knockout')) {
      return res.status(400).json({ error: 'Choose a valid stage for this league format.' });
    }
    if (stage === 'group') {
      if (tournament.format !== 'groups_knockout' || !members[0].group_key || members[0].group_key !== members[1].group_key) {
        return res.status(400).json({ error: 'Group-stage fixtures must be between players in the same assigned group.' });
      }
      const existingPair = await db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE tournament_id=? AND stage='group'
        AND ((home_user_id=? AND away_user_id=?) OR (home_user_id=? AND away_user_id=?))`).get(tournamentId, homeUserId, awayUserId, awayUserId, homeUserId);
      if (existingPair.count) return res.status(409).json({ error: 'Each group pairing can only be scheduled once.' });
    } else {
      const roundPlayers = await db.prepare(`SELECT COUNT(*) AS count FROM matches WHERE tournament_id=? AND stage='knockout'
        AND round_number=? AND (home_user_id IN (?,?) OR away_user_id IN (?,?))`).get(tournamentId, roundNumber, homeUserId, awayUserId, homeUserId, awayUserId);
      if (roundPlayers.count) return res.status(409).json({ error: 'A player can only appear once in a knockout round.' });
      if (roundNumber === 1 && tournament.format === 'groups_knockout') {
        const qualifiers = await groupStageQualifiers(tournamentId);
        const isPowerOfTwo = qualifiers?.length >= 2 && (qualifiers.length & (qualifiers.length - 1)) === 0;
        if (!isPowerOfTwo) return res.status(409).json({ error: 'Complete every group fixture first; each group must produce two qualifiers and the total must form a knockout bracket.' });
        if (!qualifiers.includes(homeUserId) || !qualifiers.includes(awayUserId)) return res.status(400).json({ error: 'Only the top two players in each group can enter the knockout round.' });
      }
      if (roundNumber > 1) {
        const previousRound = await db.prepare(`SELECT home_user_id,away_user_id,home_score,away_score,status FROM matches
          WHERE tournament_id=? AND stage='knockout' AND round_number=?`).all(tournamentId, roundNumber - 1);
        if (!previousRound.length || previousRound.some(match => match.status !== 'completed')) {
          return res.status(409).json({ error: 'Resolve every fixture in the previous knockout round before scheduling the next round.' });
        }
        const winners = previousRound.map(match => match.home_score > match.away_score ? match.home_user_id : match.away_user_id);
        if (!winners.includes(homeUserId) || !winners.includes(awayUserId)) {
          return res.status(400).json({ error: 'Only winners from the previous knockout round can advance.' });
        }
      }
    }
  }
  const result = await db.prepare(`INSERT INTO matches
    (tournament_id,home_user_id,away_user_id,scheduled_at,deadline_at,stage,round_number)
    VALUES (?,?,?,?,?,?,?)`).run(tournamentId, homeUserId, awayUserId, scheduledAt, deadlineAt, stage, roundNumber);
  res.status(201).json({ matchId: Number(result.lastInsertRowid) });
}));
app.post('/api/tournaments/:id/prize/award', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const tournament = await db.prepare("SELECT * FROM tournaments WHERE id=? AND status='finished'").get(Number(req.params.id));
  if (!tournament) return res.status(409).json({ error: 'The league must be finished before its prize is marked awarded.' });
  if (!tournament.prize_description) return res.status(400).json({ error: 'Add a prize description when creating the league to track fulfillment.' });
  if (tournament.prize_awarded) return res.status(409).json({ error: 'This league prize has already been marked awarded.' });
  await db.prepare('UPDATE tournaments SET prize_awarded=1,prize_awarded_at=CURRENT_TIMESTAMP WHERE id=? AND prize_awarded=0').run(tournament.id);
  res.json({ ok: true });
}));
app.put('/api/matches/:id/schedule', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const scheduledAt = String(req.body.scheduledAt || '');
  const deadlineAt = String(req.body.deadlineAt || '');
  if (!validIsoDate(scheduledAt) || !validIsoDate(deadlineAt) || Date.parse(deadlineAt) < Date.parse(scheduledAt)) {
    return res.status(400).json({ error: 'Set a valid kick-off and a deadline at or after kick-off.' });
  }
  const match = await db.prepare('SELECT * FROM matches WHERE id=?').get(Number(req.params.id));
  if (!match) return res.status(404).json({ error: 'Fixture not found.' });
  if (match.status !== 'scheduled') return res.status(409).json({ error: 'Only scheduled matches can be rescheduled. Resolve the submitted result first.' });
  await db.prepare('UPDATE matches SET scheduled_at=?,deadline_at=? WHERE id=?').run(scheduledAt, deadlineAt, match.id);
  res.json({ ok: true });
}));
app.post('/api/matches/:id/submit', authenticate, uploadScreenshot, jsonHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Attach a screenshot of the DLS Live Tracker result.' });
  if (!imageHasValidSignature(req.file.buffer, req.file.mimetype)) return res.status(400).json({ error: 'That file is not a valid JPEG, PNG, or WebP image.' });
  const match = await db.prepare('SELECT * FROM matches WHERE id=?').get(Number(req.params.id));
  if (!match) return res.status(404).json({ error: 'Fixture not found.' });
  if (req.user.id !== match.home_user_id && req.user.id !== match.away_user_id) return res.status(403).json({ error: 'Only a player in this fixture can submit its result.' });
  if (match.status === 'completed') return res.status(409).json({ error: 'This match result is final.' });
  if (Date.now() < Date.parse(match.scheduled_at)) return res.status(409).json({ error: 'Wait until kick-off before submitting a result.' });
  if (Date.now() > Date.parse(match.deadline_at)) return res.status(409).json({ error: 'The result deadline has passed. Ask the organizer to reschedule the fixture.' });
  const existing = await db.prepare("SELECT id FROM result_submissions WHERE match_id=? AND status IN ('pending','disputed','approved')").get(match.id);
  if (existing) return res.status(409).json({ error: 'This match already has a result awaiting review.' });
  const homeScore = Number(req.body.homeScore);
  const awayScore = Number(req.body.awayScore);
  if (!Number.isInteger(homeScore) || !Number.isInteger(awayScore) || homeScore < 0 || homeScore > 99 || awayScore < 0 || awayScore > 99) {
    return res.status(400).json({ error: 'Enter valid goals from 0 to 99 for both teams.' });
  }
  const screenshotKey = await storage.saveScreenshot(req.file);
  try {
    const save = db.transaction(async () => {
      const result = await db.prepare('INSERT INTO result_submissions (match_id,submitted_by,home_score,away_score,screenshot) VALUES (?,?,?,?,?)')
        .run(match.id, req.user.id, homeScore, awayScore, screenshotKey);
      await db.prepare("UPDATE matches SET status='pending_review' WHERE id=?").run(match.id);
      await refreshStandings(match.tournament_id);
      return Number(result.lastInsertRowid);
    });
    res.status(201).json({ ok: true, submissionId: await save() });
  } catch (error) {
    try { await storage.deleteScreenshot(screenshotKey); }
    catch (cleanupError) { console.error('[dls26] Screenshot cleanup failed:', cleanupError); }
    if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(error.code)) {
      return res.status(409).json({ error: 'This match already has a result awaiting review.' });
    }
    throw error;
  }
}));
app.post('/api/submissions/:id/dispute', authenticate, jsonHandler(async (req, res) => {
  const submission = await db.prepare(`SELECT s.*,m.tournament_id,m.home_user_id,m.away_user_id FROM result_submissions s
    JOIN matches m ON m.id=s.match_id WHERE s.id=?`).get(Number(req.params.id));
  if (!submission || !['pending','disputed'].includes(submission.status)) return res.status(404).json({ error: 'There is no pending result to dispute.' });
  if (![submission.home_user_id, submission.away_user_id].includes(req.user.id)) return res.status(403).json({ error: 'Only a player in this fixture can dispute the result.' });
  if (submission.submitted_by === req.user.id) return res.status(403).json({ error: 'The other player must flag a disputed score.' });
  await db.prepare("UPDATE result_submissions SET status='disputed' WHERE id=?").run(submission.id);
  res.json({ ok: true });
}));
app.post('/api/submissions/:id/verify', authenticate, requireAdmin, jsonHandler(async (req, res) => {
  const decision = String(req.body.decision || '');
  if (!['approved','rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  const note = String(req.body.note || '').trim().slice(0, 240);
  const submission = await db.prepare(`SELECT s.*,m.id AS target_match_id,m.tournament_id,m.status AS match_status,m.stage,m.home_user_id,m.away_user_id FROM result_submissions s
    JOIN matches m ON m.id=s.match_id WHERE s.id=?`).get(Number(req.params.id));
  if (!submission || !['pending','disputed'].includes(submission.status) || submission.match_status === 'completed') {
    return res.status(409).json({ error: 'This result is no longer awaiting review.' });
  }
  if (decision === 'approved' && submission.stage === 'knockout' && submission.home_score === submission.away_score) {
    return res.status(400).json({ error: 'Knockout matches cannot end in a draw. Reject the result and schedule a replay.' });
  }
  const verify = db.transaction(async () => {
    await db.prepare('UPDATE result_submissions SET status=?,admin_note=? WHERE id=?').run(decision, note, submission.id);
    if (decision === 'approved') {
      await db.prepare("UPDATE matches SET status='completed',home_score=?,away_score=? WHERE id=?").run(submission.home_score, submission.away_score, submission.match_id);
      await settlePredictions({ ...submission, id: submission.target_match_id });
    } else {
      await db.prepare("UPDATE matches SET status='scheduled',home_score=NULL,away_score=NULL WHERE id=?").run(submission.match_id);
    }
    await refreshStandings(submission.tournament_id);
    if (decision === 'approved') await maybeFinishTournament(submission.tournament_id);
  });
  await verify();
  res.json({ ok: true, status: decision });
}));
app.get('/api/submissions/:id/screenshot', authenticate, jsonHandler(async (req, res) => {
  const submission = await db.prepare(`SELECT s.screenshot,s.submitted_by,m.home_user_id,m.away_user_id,m.tournament_id
    FROM result_submissions s JOIN matches m ON m.id=s.match_id WHERE s.id=?`).get(Number(req.params.id));
  if (!submission) return res.status(404).json({ error: 'Screenshot not found.' });
  const isPlayer = submission.submitted_by === req.user.id || submission.home_user_id === req.user.id || submission.away_user_id === req.user.id;
  const isMember = Boolean(await db.prepare('SELECT 1 FROM tournament_players WHERE tournament_id=? AND user_id=?').get(submission.tournament_id, req.user.id));
  if (!isAdmin(req.user) && !isPlayer && !isMember) return res.status(403).json({ error: 'You do not have access to this screenshot.' });
  let screenshot;
  try {
    screenshot = await storage.readScreenshot(submission.screenshot);
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.code === 'ENOENT') return res.status(404).json({ error: 'Screenshot file is unavailable.' });
    throw error;
  }
  res.setHeader('Content-Type', screenshot.contentType);
  res.setHeader('Cache-Control', 'private, no-store');
  res.send(screenshot.body);
}));
app.post('/api/matches/:id/predictions', authenticate, jsonHandler(async (req, res) => {
  const match = await db.prepare('SELECT * FROM matches WHERE id=?').get(Number(req.params.id));
  const pickedUserId = Number(req.body.pickedUserId);
  const stake = Number(req.body.stake);
  if (!match || match.status !== 'scheduled' || Date.parse(match.scheduled_at) <= Date.now()) return res.status(409).json({ error: 'Predictions close at kick-off.' });
  if (![match.home_user_id, match.away_user_id].includes(pickedUserId) || !Number.isSafeInteger(stake) || stake < 1 || stake > 10000) {
    return res.status(400).json({ error: 'Choose a team and stake between 1 and 10,000 points.' });
  }
  if ([match.home_user_id, match.away_user_id].includes(req.user.id)) return res.status(403).json({ error: 'Players in this match cannot predict the result.' });
  if (req.user.points < stake) return res.status(400).json({ error: 'You do not have enough Arena points.' });
  const makePrediction = db.transaction(async () => {
    const updated = await db.prepare('UPDATE users SET points=points-? WHERE id=? AND points>=?').run(stake, req.user.id, stake);
    if (!updated.changes) throw new Error('You do not have enough Arena points.');
    await db.prepare('INSERT INTO predictions (match_id,user_id,picked_user_id,stake) VALUES (?,?,?,?)').run(match.id, req.user.id, pickedUserId, stake);
  });
  try { await makePrediction(); }
  catch (error) {
    if (['SQLITE_CONSTRAINT_UNIQUE', '23505'].includes(error.code)) return res.status(409).json({ error: 'You already made a prediction for this fixture.' });
    if (error.message === 'You do not have enough Arena points.') return res.status(400).json({ error: error.message });
    throw error;
  }
  res.status(201).json({ ok: true });
}));
app.post('/api/matches/:id/claim', authenticate, jsonHandler(async (req, res) => {
  const prediction = await db.prepare(`SELECT p.* FROM predictions p JOIN matches m ON m.id=p.match_id
    WHERE p.match_id=? AND p.user_id=? AND m.status='completed'`).get(Number(req.params.id), req.user.id);
  if (!prediction) return res.status(404).json({ error: 'No settled prediction found.' });
  if (prediction.claimed) return res.status(409).json({ error: 'That prize was already claimed.' });
  if (!prediction.prize) return res.status(400).json({ error: 'This prediction did not win any points.' });
  const claim = db.transaction(async () => {
    const updated = await db.prepare('UPDATE predictions SET claimed=1 WHERE id=? AND claimed=0').run(prediction.id);
    if (!updated.changes) throw new Error('That prize was already claimed.');
    await db.prepare('UPDATE users SET points=points+? WHERE id=?').run(prediction.prize, req.user.id);
  });
  await claim();
  res.json({ ok: true, prize: prediction.prize });
}));

app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
  }
}));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  console.error('[dls26]', error);
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

function startServer() {
  const server = app.listen(PORT, () => console.log(`DLS 26 Arena running at http://localhost:${PORT}`));
  if (!process.env.VERCEL) {
    const tournamentFinalizer = setInterval(() => {
      databaseReady.then(() => finalizeReadyTournaments())
        .catch(error => console.error('[dls26] Tournament finalization failed:', error));
    }, 60 * 1000);
    tournamentFinalizer.unref();
  }
  finalizeReadyTournaments().catch(error => console.error('[dls26] Tournament finalization failed:', error));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(async () => {
      await db.close();
      process.exit(0);
    }));
  }
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = app;
