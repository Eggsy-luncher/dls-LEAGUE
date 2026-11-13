require('dotenv').config();

const fs = require('node:fs/promises');
const path = require('node:path');
const Database = require('better-sqlite3');
const db = require('../db');
const storage = require('../storage');

const TABLES = {
  users: ['id', 'email', 'password_hash', 'display_name', 'gamer_tag', 'points', 'role', 'email_verified', 'created_at'],
  tournaments: ['id', 'name', 'status', 'format', 'starts_at', 'ends_at', 'reward_points', 'prize_description',
    'prize_awarded', 'prize_awarded_at', 'champion_user_id', 'ended_at', 'created_at'],
  tournament_players: ['tournament_id', 'user_id', 'group_key'],
  matches: ['id', 'tournament_id', 'home_user_id', 'away_user_id', 'scheduled_at', 'deadline_at', 'stage',
    'round_number', 'status', 'home_score', 'away_score', 'created_at'],
  result_submissions: ['id', 'match_id', 'submitted_by', 'home_score', 'away_score', 'screenshot', 'status',
    'admin_note', 'created_at'],
  predictions: ['id', 'match_id', 'user_id', 'picked_user_id', 'stake', 'prize', 'claimed'],
  pending_verifications: ['email', 'password_hash', 'display_name', 'gamer_tag', 'token_hash', 'expires_at', 'created_at']
};
const SEQUENCED_TABLES = ['users', 'tournaments', 'matches', 'result_submissions', 'predictions'];
const sourceDirectory = path.resolve(process.env.SQLITE_DATA_DIR || path.join(__dirname, '..', 'data'));
const sourcePath = path.resolve(process.env.SQLITE_SOURCE || path.join(sourceDirectory, 'dls26.db'));
const uploadedKeys = [];

function sourceRows(source, table) {
  const exists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return exists ? source.prepare(`SELECT * FROM ${table}`).all() : [];
}

function upgradeSourceSchema(source) {
  const additions = {
    users: {
      role: "TEXT NOT NULL DEFAULT 'player'",
      email_verified: 'INTEGER NOT NULL DEFAULT 0'
    },
    tournaments: {
      format: "TEXT NOT NULL DEFAULT 'single_round_robin'",
      ends_at: 'TEXT',
      reward_points: 'INTEGER NOT NULL DEFAULT 100',
      prize_description: "TEXT NOT NULL DEFAULT ''",
      prize_awarded: 'INTEGER NOT NULL DEFAULT 0',
      prize_awarded_at: 'TEXT',
      champion_user_id: 'INTEGER REFERENCES users(id)',
      ended_at: 'TEXT'
    },
    tournament_players: { group_key: "TEXT NOT NULL DEFAULT ''" },
    matches: {
      stage: "TEXT NOT NULL DEFAULT 'league'",
      round_number: 'INTEGER NOT NULL DEFAULT 1'
    }
  };
  for (const [table, columns] of Object.entries(additions)) {
    const tableExists = source.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    if (!tableExists) continue;
    const existing = new Set(source.pragma(`table_info(${table})`).map(column => column.name));
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing.has(column)) source.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

function insertStatement(table, columns) {
  const columnList = columns.join(',');
  const placeholders = columns.map(() => '?').join(',');
  return db.prepare(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`);
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL to the destination PostgreSQL database.');
  if (!db.isPostgres) throw new Error('This migration requires DATABASE_URL; it will not write into SQLite.');
  await Promise.all([db.initialize(), storage.initialize()]);
  const source = new Database(sourcePath, { fileMustExist: true });

  try {
    upgradeSourceSchema(source);
    const rows = Object.fromEntries(Object.keys(TABLES).map(table => [table, sourceRows(source, table)]));
    for (const table of Object.keys(TABLES)) {
      const target = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      if (target.count) throw new Error(`Destination table "${table}" is not empty. Refusing to mix or overwrite data.`);
    }

    const screenshots = new Map();
    for (const row of rows.result_submissions) {
      const originalKey = path.basename(row.screenshot);
      const imagePath = path.join(sourceDirectory, 'uploads', originalKey);
      const buffer = await fs.readFile(imagePath);
      const extension = path.extname(originalKey).toLowerCase();
      const mimetype = ({ '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[extension];
      if (!mimetype) throw new Error(`Unsupported screenshot extension for "${originalKey}".`);
      await storage.saveScreenshot({ buffer, size: buffer.length, mimetype }, originalKey);
      screenshots.set(row.id, originalKey);
      uploadedKeys.push(originalKey);
    }

    const migrate = db.transaction(async () => {
      for (const table of Object.keys(TABLES)) {
        const columns = TABLES[table];
        const insert = insertStatement(table, columns);
        for (const row of rows[table]) {
          const values = columns.map(column => {
            if (table === 'result_submissions' && column === 'screenshot') return screenshots.get(row.id);
            if (column === 'email') return String(row[column]).trim().toLowerCase();
            return row[column] ?? null;
          });
          await insert.run(...values);
        }
      }

      for (const table of SEQUENCED_TABLES) {
        await db.prepare(`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
          COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${table}`).get();
      }
    });
    await migrate();
    console.log(`Migrated ${Object.values(rows).reduce((total, items) => total + items.length, 0)} records and ${uploadedKeys.length} screenshots.`);
  } catch (error) {
    for (const key of uploadedKeys) {
      try { await storage.deleteScreenshot(key); }
      catch (cleanupError) { console.error(`[migration] Could not remove uploaded object ${key}:`, cleanupError); }
    }
    throw error;
  } finally {
    source.close();
    await db.close();
  }
}

main().catch(error => {
  console.error('[migration] SQLite transfer failed:', error);
  process.exitCode = 1;
});
