/**
 * Service desk trainer backend
 * ------------------
 * Keeps the Gemini API key on the server (never sent to the browser) and
 * proxies the two calls the frontend needs:
 *   POST /api/turn   -> one client-reply turn during the chat
 *   POST /api/score  -> the end-of-session scoring/report call
 *
 * Also handles authentication, user management, reports, and admin routes.
 *
 * Run:
 *   npm install
 *   npm start
 * Then open http://localhost:3000
 */

const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const db = require('./db');
const auth = require('./auth');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.attachUser);
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------
// API key is read from an environment variable — set GEMINI_API_KEY in
// your hosting provider's project settings (e.g. Vercel > Settings >
// Environment Variables), or in a local .env file for local dev.
// Get a key at https://aistudio.google.com/apikey
// ---------------------------------------------------------------------
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const MODEL = 'gemini-3.1-flash-lite';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

async function callGemini(systemPrompt, contents, schema) {
  if (!GEMINI_API_KEY || GEMINI_API_KEY === 'PASTE_YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('No Gemini API key configured. Set the GEMINI_API_KEY environment variable.');
  }

  const res = await fetch(API_BASE + MODEL + ':generateContent?key=' + GEMINI_API_KEY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents,
      generationConfig: { temperature: 0.9, responseMimeType: 'application/json', responseSchema: schema }
    })
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch (e) { /* ignore */ }
    throw new Error('Gemini error ' + res.status + (detail ? ': ' + detail : ''));
  }

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  if (!text) throw new Error('Empty response from model.');

  const cleaned = text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '');
  return JSON.parse(cleaned);
}

// =====================================================================
// Gemini proxy routes
// =====================================================================

app.post('/api/turn', async (req, res) => {
  try {
    const { systemPrompt, contents, schema } = req.body || {};
    if (!systemPrompt || !contents || !schema) {
      return res.status(400).json({ error: 'Missing systemPrompt, contents, or schema.' });
    }
    const data = await callGemini(systemPrompt, contents, schema);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/score', async (req, res) => {
  try {
    const { systemPrompt, contents, schema, meta } = req.body || {};
    if (!systemPrompt || !contents || !schema) {
      return res.status(400).json({ error: 'Missing systemPrompt, contents, or schema.' });
    }
    const data = await callGemini(systemPrompt, contents, schema);

    // Save the report to the database if a user is signed in
    if (req.user && meta) {
      try {
        const saved = await db.createReport(req.user.sub, {
          ticketId: meta.ticketId || 'UNKNOWN',
          scenario: meta.scenario || 'Unknown',
          mood: meta.mood || 'Unknown',
          finalStatus: meta.finalStatus || 'unknown',
          overallScore: data.overall_score || 0,
          empathy: data.empathy || 0,
          technicalAccuracy: data.technical_accuracy || 0,
          resolution: data.resolution || 0,
          communication: data.communication || 0,
          verdict: data.verdict || '',
          strengths: data.strengths || [],
          improvements: data.improvements || [],
          transcript: meta.transcript || []
        });
        data.reportId = saved.id;
      } catch (dbErr) {
        console.error('[score] Failed to save report:', dbErr.message);
        // Still return the score even if save fails
      }
    }

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Auth routes
// =====================================================================

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, sapId, password, confirmPassword, project, lob } = req.body || {};
    if (!name || !email || !sapId || !password || !confirmPassword) {
      return res.status(400).json({ error: 'All fields are required.' });
    }
    if (!project) {
      return res.status(400).json({ error: 'Project is required.' });
    }
    if (!lob) {
      return res.status(400).json({ error: 'Line of Business is required.' });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existingEmail = await db.findUserByEmail(email);
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }
    const existingSap = await db.findUserBySapId(sapId);
    if (existingSap) {
      return res.status(409).json({ error: 'An account with this SAP ID already exists.' });
    }

    const passwordHash = await auth.hashPassword(password);
    const user = await db.createUser({ name, email, sapId, passwordHash, project, lob });
    const token = auth.issueToken(user);
    auth.setAuthCookie(res, token);
    res.json({ id: user.id, name: user.name, email: user.email, sap_id: user.sap_id, project: user.project, lob: user.lob, role: user.role });
  } catch (err) {
    console.error('[signup]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Enter your email and password.' });
    }

    const user = await db.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await auth.verifyPassword(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = auth.issueToken(user);
    auth.setAuthCookie(res, token);
    res.json({ id: user.id, name: user.name, email: user.email, sap_id: user.sap_id, role: user.role });
  } catch (err) {
    console.error('[login]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  auth.clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const user = await db.findUserById(req.user.sub);
    if (!user) return res.status(401).json({ error: 'User not found.' });
    res.json({ id: user.id, name: user.name, email: user.email, sap_id: user.sap_id, project: user.project, lob: user.lob, role: user.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Reports routes (authenticated users)
// =====================================================================

app.get('/api/reports', auth.requireAuth, async (req, res) => {
  try {
    const reports = await db.listReportsByUser(req.user.sub);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/reports/:id/download', auth.requireAuth, async (req, res) => {
  try {
    const report = await db.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });

    // Only allow the owner or an admin to download
    if (report.user_id !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const lines = [
      'SERVICE DESK TRAINING REPORT',
      '============================',
      '',
      'Ticket:     ' + report.ticket_id,
      'Scenario:   ' + report.scenario,
      'Mood:       ' + report.mood,
      'Outcome:    ' + report.final_status,
      'Date:       ' + new Date(report.created_at).toLocaleString(),
      '',
      'SCORES',
      '------',
      'Overall:              ' + report.overall_score,
      'Empathy:              ' + report.empathy,
      'Technical accuracy:   ' + report.technical_accuracy,
      'Resolution:           ' + report.resolution,
      'Communication:        ' + report.communication,
      '',
      'Verdict: ' + report.verdict,
      '',
      'STRENGTHS',
      '---------',
      ...(report.strengths || []).map((s, i) => (i + 1) + '. ' + s),
      '',
      'IMPROVEMENTS',
      '------------',
      ...(report.improvements || []).map((s, i) => (i + 1) + '. ' + s),
      '',
      'TRANSCRIPT',
      '----------',
      ...(report.transcript || []).map(m => (m.role === 'agent' ? 'Agent: ' : 'Client: ') + m.text),
      ''
    ];

    const filename = report.ticket_id + '-report.txt';
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(lines.join('\n'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Admin routes
// =====================================================================

app.get('/api/admin/users', auth.requireAdmin, async (req, res) => {
  try {
    const users = await db.listUsersWithStats();
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/users/:id/reports', auth.requireAdmin, async (req, res) => {
  try {
    const user = await db.findUserById(parseInt(req.params.id, 10));
    if (!user) return res.status(404).json({ error: 'User not found.' });
    const reports = await db.listReportsByUser(user.id);
    res.json({ user, reports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/users/:id/reset-password', auth.requireAdmin, async (req, res) => {
  try {
    const { newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const userId = parseInt(req.params.id, 10);
    const user = await db.findUserById(userId);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const hash = await auth.hashPassword(newPassword);
    await db.setUserPassword(userId, hash);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =====================================================================
// Start server
// =====================================================================

const PORT = process.env.PORT || 3000;

async function boot() {
  try {
    await db.initSchema();
    console.log('[db] Schema initialized.');
  } catch (err) {
    console.error('[db] Schema init failed:', err.message);
    console.warn('[db] The app will start but auth/reports/admin features will not work.');
  }

  app.listen(PORT, () => {
    console.log('Server running at http://localhost:' + PORT);
  });
}

boot();
