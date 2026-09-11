// db.js
// Postgres access layer, designed for Neon (https://neon.tech) but works with any
// standard Postgres connection string. All queries go through a single pool.

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set. Auth, reports, and the admin portal will not work until it is configured.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function query(text, params) {
  return pool.query(text, params);
}

/**
 * Creates the schema if it does not already exist. Safe to run on every boot.
 */
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE,
      sap_id        TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      project       TEXT NOT NULL DEFAULT '',
      lob           TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Migrate existing tables that don't have the new columns yet
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT ''`);
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS lob TEXT NOT NULL DEFAULT ''`);

  await query(`
    CREATE TABLE IF NOT EXISTS reports (
      id                  SERIAL PRIMARY KEY,
      user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      ticket_id           TEXT NOT NULL,
      scenario            TEXT NOT NULL,
      mood                TEXT NOT NULL,
      final_status        TEXT NOT NULL,
      overall_score       NUMERIC NOT NULL,
      empathy             NUMERIC NOT NULL,
      technical_accuracy  NUMERIC NOT NULL,
      resolution          NUMERIC NOT NULL,
      communication       NUMERIC NOT NULL,
      verdict             TEXT NOT NULL,
      strengths           JSONB NOT NULL DEFAULT '[]',
      improvements        JSONB NOT NULL DEFAULT '[]',
      transcript          JSONB NOT NULL DEFAULT '[]',
      created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await query(`CREATE INDEX IF NOT EXISTS idx_reports_user_id ON reports(user_id);`);

  // One-time admin bootstrap from environment variables, so there is always a way
  // into the admin portal without exposing admin creation through public sign-up.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const existing = await query('SELECT id FROM users WHERE email = $1', [process.env.ADMIN_EMAIL.toLowerCase()]);
    if (existing.rows.length === 0) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await query(
        `INSERT INTO users (name, email, sap_id, password_hash, project, lob, role)
         VALUES ($1, $2, $3, $4, $5, $6, 'admin')`,
        [process.env.ADMIN_NAME || 'Administrator', process.env.ADMIN_EMAIL.toLowerCase(), process.env.ADMIN_SAP_ID || 'ADMIN-0001', hash, '', '']
      );
      console.log('[db] Seeded initial admin account for', process.env.ADMIN_EMAIL);
    }
  }
}

/* ---------------- users ---------------- */

async function createUser({ name, email, sapId, passwordHash, project, lob }) {
  const result = await query(
    `INSERT INTO users (name, email, sap_id, password_hash, project, lob)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, name, email, sap_id, project, lob, role, created_at`,
    [name, email.toLowerCase(), sapId, passwordHash, project || '', lob || '']
  );
  return result.rows[0];
}

async function findUserByEmail(email) {
  const result = await query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  return result.rows[0] || null;
}

async function findUserBySapId(sapId) {
  const result = await query('SELECT * FROM users WHERE sap_id = $1', [sapId]);
  return result.rows[0] || null;
}

async function findUserById(id) {
  const result = await query('SELECT id, name, email, sap_id, project, lob, role, created_at FROM users WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function setUserPassword(userId, passwordHash) {
  await query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
}

async function listUsersWithStats() {
  const result = await query(`
    SELECT
      u.id, u.name, u.email, u.sap_id, u.project, u.lob, u.role, u.created_at,
      COUNT(r.id)::int                         AS report_count,
      COALESCE(ROUND(AVG(r.overall_score)), 0) AS avg_score,
      MAX(r.created_at)                        AS last_session_at
    FROM users u
    LEFT JOIN reports r ON r.user_id = u.id
    WHERE u.role = 'user'
    GROUP BY u.id
    ORDER BY u.created_at DESC
  `);
  return result.rows;
}

/* ---------------- reports ---------------- */

async function createReport(userId, r) {
  const result = await query(
    `INSERT INTO reports
      (user_id, ticket_id, scenario, mood, final_status, overall_score, empathy,
       technical_accuracy, resolution, communication, verdict, strengths, improvements, transcript)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      userId, r.ticketId, r.scenario, r.mood, r.finalStatus, r.overallScore, r.empathy,
      r.technicalAccuracy, r.resolution, r.communication, r.verdict,
      JSON.stringify(r.strengths || []), JSON.stringify(r.improvements || []), JSON.stringify(r.transcript || [])
    ]
  );
  return result.rows[0];
}

async function listReportsByUser(userId) {
  const result = await query('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
  return result.rows;
}

async function getReportById(reportId) {
  const result = await query('SELECT * FROM reports WHERE id = $1', [reportId]);
  return result.rows[0] || null;
}

module.exports = {
  pool, query, initSchema,
  createUser, findUserByEmail, findUserBySapId, findUserById, setUserPassword, listUsersWithStats,
  createReport, listReportsByUser, getReportById
};