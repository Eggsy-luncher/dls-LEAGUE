const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');

const isPostgres = Boolean(process.env.DATABASE_URL);
const transactionContext = new AsyncLocalStorage();
let sqlite;
let pool;

function postgresSql(sql) {
  const normalized = sql
    .replace(/([a-z_][a-z0-9_]*)\s*=\s*\?\s+COLLATE NOCASE/gi, 'LOWER($1)=LOWER(?)')
    .replace(/([a-z_][a-z0-9_.]*)\s+COLLATE NOCASE/gi, 'LOWER($1)')
    .replace(/\bAS\s+([a-z_][a-z0-9_]*[A-Z][a-zA-Z0-9_]*)\b/g, 'AS "$1"')
    .replace(/\bCURRENT_TIMESTAMP\b/g, 'CURRENT_TIMESTAMP::text');
  let index = 0;
  return normalized.replace(/\?/g, () => `$${++index}`);
}

function prepare(sql) {
  return {
    get(...values) {
      if (!isPostgres) return sqlite.prepare(sql).get(...values);
      return execute(sql, values).then(result => result.rows[0]);
    },
    all(...values) {
      if (!isPostgres) return sqlite.prepare(sql).all(...values);
      return execute(sql, values).then(result => result.rows);
    },
    run(...values) {
      if (!isPostgres) return sqlite.prepare(sql).run(...values);
      const insertTable = sql.match(/^\s*INSERT\s+INTO\s+([a-z_]+)/i)?.[1];
      const returnsId = ['users', 'tournaments', 'matches', 'result_submissions'].includes(insertTable);
      const query = returnsId && !/\bRETURNING\b/i.test(sql) ? `${sql} RETURNING id` : sql;
      return execute(query, values).then(result => ({
        changes: result.rowCount,
        lastInsertRowid: result.rows[0]?.id
      }));
    }
  };
}

function execute(sql, values = []) {
  const client = transactionContext.getStore();
  const executor = client || pool;
  return executor.query(postgresSql(sql), values);
}

function transaction(callback) {
  return async (...args) => {
    if (!isPostgres) {
      if (transactionContext.getStore()) return callback(...args);
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const result = await transactionContext.run({ sqlite: true }, () => callback(...args));
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }

    if (transactionContext.getStore()) return callback(...args);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await transactionContext.run(client, () => callback(...args));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  };
}

async function initialize() {
  if (process.env.NODE_ENV === 'production' && !isPostgres) {
    throw new Error('DATABASE_URL is required in production; SQLite is supported only for local development.');
  }
  if (isPostgres) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, value => Number(value));
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 5),
      idleTimeoutMillis: 10000,
      connectionTimeoutMillis: 10000
    });
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        gamer_tag TEXT NOT NULL,
        points INTEGER NOT NULL DEFAULT 1000 CHECK(points >= 0),
        role TEXT NOT NULL DEFAULT 'player',
        email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_unique ON users (LOWER(email));
      CREATE UNIQUE INDEX IF NOT EXISTS users_gamer_tag_lower_unique ON users (LOWER(gamer_tag));
      CREATE TABLE IF NOT EXISTS tournaments (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','finished')),
        format TEXT NOT NULL DEFAULT 'single_round_robin',
        starts_at TEXT,
        ends_at TEXT,
        reward_points INTEGER NOT NULL DEFAULT 100,
        prize_description TEXT NOT NULL DEFAULT '',
        prize_awarded INTEGER NOT NULL DEFAULT 0,
        prize_awarded_at TEXT,
        champion_user_id INTEGER REFERENCES users(id),
        ended_at TEXT,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
      );
      CREATE TABLE IF NOT EXISTS tournament_players (
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        group_key TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tournament_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS matches (
        id SERIAL PRIMARY KEY,
        tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
        home_user_id INTEGER NOT NULL,
        away_user_id INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'league',
        round_number INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','pending_review','completed')),
        home_score INTEGER,
        away_score INTEGER,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text),
        CHECK(home_user_id <> away_user_id),
        FOREIGN KEY(tournament_id, home_user_id) REFERENCES tournament_players(tournament_id, user_id) ON DELETE CASCADE,
        FOREIGN KEY(tournament_id, away_user_id) REFERENCES tournament_players(tournament_id, user_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS result_submissions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        home_score INTEGER NOT NULL CHECK(home_score BETWEEN 0 AND 99),
        away_score INTEGER NOT NULL CHECK(away_score BETWEEN 0 AND 99),
        screenshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','disputed')),
        admin_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
      );
      CREATE TABLE IF NOT EXISTS predictions (
        id SERIAL PRIMARY KEY,
        match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        picked_user_id INTEGER NOT NULL REFERENCES users(id),
        stake INTEGER NOT NULL CHECK(stake > 0),
        prize INTEGER NOT NULL DEFAULT 0,
        claimed INTEGER NOT NULL DEFAULT 0,
        UNIQUE(match_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS pending_verifications (
        email TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        gamer_tag TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP::text)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pending_verifications_gamer_tag_lower_unique
        ON pending_verifications (LOWER(gamer_tag));
      CREATE INDEX IF NOT EXISTS idx_matches_tournament_time ON matches(tournament_id, scheduled_at);
      CREATE INDEX IF NOT EXISTS idx_submissions_match_status ON result_submissions(match_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_one_active_per_match
        ON result_submissions(match_id) WHERE status IN ('pending','disputed','approved');
      CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id);
    `);
    await pool.query("UPDATE users SET role='player' WHERE LOWER(email)=LOWER($1) AND email_verified=0", [process.env.DLS_ADMIN_EMAIL || 'ossommordecai@gmail.com']);
    return;
  }

  const dataDirectory = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
  fs.mkdirSync(path.join(dataDirectory, 'uploads'), { recursive: true });
  const Database = require('better-sqlite3');
  sqlite = new Database(path.join(dataDirectory, 'dls26.db'));
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      gamer_tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
      points INTEGER NOT NULL DEFAULT 1000 CHECK(points >= 0),
      role TEXT NOT NULL DEFAULT 'player',
      email_verified INTEGER NOT NULL DEFAULT 0 CHECK(email_verified IN (0,1)),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','finished')),
      format TEXT NOT NULL DEFAULT 'single_round_robin',
      starts_at TEXT,
      ends_at TEXT,
      reward_points INTEGER NOT NULL DEFAULT 100,
      prize_description TEXT NOT NULL DEFAULT '',
      prize_awarded INTEGER NOT NULL DEFAULT 0,
      prize_awarded_at TEXT,
      champion_user_id INTEGER REFERENCES users(id),
      ended_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tournament_players (
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      group_key TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (tournament_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
      home_user_id INTEGER NOT NULL,
      away_user_id INTEGER NOT NULL,
      scheduled_at TEXT NOT NULL,
      deadline_at TEXT NOT NULL,
      stage TEXT NOT NULL DEFAULT 'league',
      round_number INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('scheduled','pending_review','completed')),
      home_score INTEGER,
      away_score INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK(home_user_id <> away_user_id),
      FOREIGN KEY(tournament_id, home_user_id) REFERENCES tournament_players(tournament_id, user_id) ON DELETE CASCADE,
      FOREIGN KEY(tournament_id, away_user_id) REFERENCES tournament_players(tournament_id, user_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS result_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      submitted_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      home_score INTEGER NOT NULL CHECK(home_score BETWEEN 0 AND 99),
      away_score INTEGER NOT NULL CHECK(away_score BETWEEN 0 AND 99),
      screenshot TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','disputed')),
      admin_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS predictions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      picked_user_id INTEGER NOT NULL REFERENCES users(id),
      stake INTEGER NOT NULL CHECK(stake > 0),
      prize INTEGER NOT NULL DEFAULT 0,
      claimed INTEGER NOT NULL DEFAULT 0,
      UNIQUE(match_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS pending_verifications (
      email TEXT PRIMARY KEY COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      gamer_tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_matches_tournament_time ON matches(tournament_id, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_submissions_match_status ON result_submissions(match_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_submissions_one_active_per_match
      ON result_submissions(match_id) WHERE status IN ('pending','disputed','approved');
    CREATE INDEX IF NOT EXISTS idx_predictions_match ON predictions(match_id);
  `);

  function ensureColumn(table, column, definition) {
    if (!sqlite.pragma(`table_info(${table})`).some(item => item.name === column)) {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  ensureColumn('users', 'role', "TEXT NOT NULL DEFAULT 'player'");
  ensureColumn('users', 'email_verified', 'INTEGER NOT NULL DEFAULT 0');
  sqlite.prepare("UPDATE users SET role='player' WHERE email=? COLLATE NOCASE AND email_verified=0")
    .run(process.env.DLS_ADMIN_EMAIL || 'ossommordecai@gmail.com');
  ensureColumn('tournaments', 'format', "TEXT NOT NULL DEFAULT 'single_round_robin'");
  ensureColumn('tournaments', 'ends_at', 'TEXT');
  ensureColumn('tournaments', 'reward_points', 'INTEGER NOT NULL DEFAULT 100');
  ensureColumn('tournaments', 'prize_description', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('tournaments', 'prize_awarded', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('tournaments', 'prize_awarded_at', 'TEXT');
  ensureColumn('tournaments', 'champion_user_id', 'INTEGER REFERENCES users(id)');
  ensureColumn('tournaments', 'ended_at', 'TEXT');
  ensureColumn('tournament_players', 'group_key', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('matches', 'stage', "TEXT NOT NULL DEFAULT 'league'");
  ensureColumn('matches', 'round_number', 'INTEGER NOT NULL DEFAULT 1');
}

async function close() {
  if (pool) await pool.end();
  if (sqlite?.open) sqlite.close();
}

module.exports = {
  isPostgres,
  initialize,
  prepare,
  transaction,
  close
};
