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

// Excel report download (styled with ExcelJS)
app.get('/api/reports/:id/download-excel', auth.requireAuth, async (req, res) => {
  try {
    const ExcelJS = require('exceljs');
    const report = await db.getReportById(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found.' });

    if (report.user_id !== req.user.sub && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const user = await db.findUserById(report.user_id);
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Service Desk Trainer';
    wb.created = new Date();

    // Color palette
    const NAVY    = '0B1929';
    const BLUE    = '4C8DFF';
    const WHITE   = 'FFFFFF';
    const LGRAY   = 'F2F4F7';
    const DGRAY   = '5B6672';
    const GREEN   = '2BD4A0';
    const AMBER   = 'F2A93B';
    const RED     = 'E5484D';
    const LTGREEN = 'E6F9F1';
    const LTAMBER = 'FFF5E0';
    const LTRED   = 'FDECEC';
    const LTBLUE  = 'E8F0FF';

    const scoreColor = (v) => Number(v) >= 70 ? GREEN : Number(v) >= 40 ? AMBER : RED;
    const scoreBg    = (v) => Number(v) >= 70 ? LTGREEN : Number(v) >= 40 ? LTAMBER : LTRED;

    const headerFont = { name: 'Calibri', bold: true, size: 11, color: { argb: WHITE } };
    const sectionFont = { name: 'Calibri', bold: true, size: 11, color: { argb: NAVY } };
    const labelFont = { name: 'Calibri', size: 10, color: { argb: DGRAY } };
    const valueFont = { name: 'Calibri', size: 10, color: { argb: '16202B' } };
    const scoreLabelFont = { name: 'Calibri', bold: true, size: 10, color: { argb: '16202B' } };

    const thinBorder = {
      top: { style: 'thin', color: { argb: 'DCE2E8' } },
      bottom: { style: 'thin', color: { argb: 'DCE2E8' } },
      left: { style: 'thin', color: { argb: 'DCE2E8' } },
      right: { style: 'thin', color: { argb: 'DCE2E8' } }
    };

    // ===================== SHEET 1: REPORT SUMMARY =====================
    const ws = wb.addWorksheet('Report Summary', {
      properties: { defaultColWidth: 20 }
    });
    ws.columns = [
      { width: 22 }, { width: 32 }, { width: 12 }
    ];

    // --- Title banner ---
    let row = ws.addRow(['SERVICE DESK TRAINING REPORT']);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).font = { name: 'Calibri', bold: true, size: 16, color: { argb: WHITE } };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    row.height = 40;
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };

    ws.addRow([]);

    // --- Trainee Info section ---
    row = ws.addRow(['TRAINEE INFORMATION']);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).font = headerFont;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.height = 26;

    const userFields = [
      ['Name', user ? user.name : 'Unknown'],
      ['Email', user ? user.email : 'Unknown'],
      ['SAP ID', user ? user.sap_id : 'Unknown'],
      ['Project', user ? (user.project || '—') : '—'],
      ['Line of Business', user ? (user.lob || '—') : '—'],
    ];
    userFields.forEach((f, i) => {
      row = ws.addRow(f);
      const bg = i % 2 === 0 ? LGRAY : WHITE;
      row.getCell(1).font = labelFont;
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      row.getCell(1).border = thinBorder;
      row.getCell(2).font = { ...valueFont, bold: true };
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      row.getCell(2).border = thinBorder;
      row.height = 22;
    });

    ws.addRow([]);

    // --- Session Details section ---
    row = ws.addRow(['SESSION DETAILS']);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).font = headerFont;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.height = 26;

    const sessionFields = [
      ['Ticket ID', report.ticket_id],
      ['Scenario', report.scenario],
      ['Client Mood', report.mood],
      ['Outcome', report.final_status],
      ['Date', new Date(report.created_at).toLocaleString()],
    ];
    sessionFields.forEach((f, i) => {
      row = ws.addRow(f);
      const bg = i % 2 === 0 ? LGRAY : WHITE;
      row.getCell(1).font = labelFont;
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      row.getCell(1).border = thinBorder;
      row.getCell(2).font = { ...valueFont, bold: true };
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
      row.getCell(2).border = thinBorder;
      row.height = 22;
    });

    ws.addRow([]);

    // --- Scores section ---
    row = ws.addRow(['PERFORMANCE SCORES', '', 'Score']);
    ws.mergeCells(row.number, 1, row.number, 2);
    row.getCell(1).font = headerFont;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(3).font = { ...headerFont, size: 10 };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BLUE } };
    row.getCell(3).alignment = { horizontal: 'center' };
    row.height = 26;

    const scores = [
      ['Overall Score', report.overall_score],
      ['Empathy', report.empathy],
      ['Technical Accuracy', report.technical_accuracy],
      ['Resolution', report.resolution],
      ['Communication', report.communication],
    ];
    scores.forEach(([label, val]) => {
      row = ws.addRow([label, '', Number(val)]);
      ws.mergeCells(row.number, 1, row.number, 2);
      row.getCell(1).font = label === 'Overall Score'
        ? { name: 'Calibri', bold: true, size: 12, color: { argb: NAVY } }
        : scoreLabelFont;
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: scoreBg(val) } };
      row.getCell(1).border = thinBorder;
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: scoreBg(val) } };
      row.getCell(2).border = thinBorder;
      row.getCell(3).font = { name: 'Calibri', bold: true, size: label === 'Overall Score' ? 14 : 11, color: { argb: scoreColor(val) } };
      row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: scoreBg(val) } };
      row.getCell(3).alignment = { horizontal: 'center' };
      row.getCell(3).border = thinBorder;
      row.height = label === 'Overall Score' ? 30 : 24;
    });

    ws.addRow([]);

    // --- Verdict ---
    row = ws.addRow(['VERDICT']);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).font = headerFont;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.height = 26;

    row = ws.addRow([report.verdict]);
    ws.mergeCells(row.number, 1, row.number, 3);
    row.getCell(1).font = { name: 'Calibri', size: 11, italic: true, color: { argb: '16202B' } };
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LTBLUE } };
    row.getCell(1).alignment = { wrapText: true, vertical: 'top' };
    row.getCell(1).border = thinBorder;
    row.height = 36;

    // ===================== SHEET 2: FEEDBACK =====================
    const ws2 = wb.addWorksheet('Feedback');
    ws2.columns = [{ width: 5 }, { width: 50 }, { width: 4 }, { width: 5 }, { width: 50 }];

    // Strengths header
    row = ws2.addRow(['', '✅  WHAT WORKED WELL', '', '', '⚠️  AREAS FOR IMPROVEMENT']);
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    row.getCell(2).font = { name: 'Calibri', bold: true, size: 12, color: { argb: WHITE } };
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREEN } };
    row.getCell(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: WHITE } };
    row.getCell(4).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
    row.getCell(5).font = { name: 'Calibri', bold: true, size: 12, color: { argb: WHITE } };
    row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: AMBER } };
    row.height = 30;

    const strengths = report.strengths || [];
    const improvements = report.improvements || [];
    const maxFeedback = Math.max(strengths.length, improvements.length, 1);
    for (let i = 0; i < maxFeedback; i++) {
      row = ws2.addRow([
        strengths[i] ? (i + 1) : '', strengths[i] || '',
        '',
        improvements[i] ? (i + 1) : '', improvements[i] || ''
      ]);
      row.getCell(1).font = { name: 'Calibri', bold: true, size: 10, color: { argb: GREEN } };
      row.getCell(1).alignment = { horizontal: 'center' };
      row.getCell(2).font = valueFont;
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? LTGREEN : WHITE } };
      row.getCell(2).border = thinBorder;
      row.getCell(2).alignment = { wrapText: true };
      row.getCell(4).font = { name: 'Calibri', bold: true, size: 10, color: { argb: AMBER } };
      row.getCell(4).alignment = { horizontal: 'center' };
      row.getCell(5).font = valueFont;
      row.getCell(5).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? LTAMBER : WHITE } };
      row.getCell(5).border = thinBorder;
      row.getCell(5).alignment = { wrapText: true };
      row.height = 24;
    }

    // ===================== SHEET 3: TRANSCRIPT =====================
    const ws3 = wb.addWorksheet('Transcript');
    ws3.columns = [{ width: 12 }, { width: 90 }];

    row = ws3.addRow(['Role', 'Message']);
    row.getCell(1).font = headerFont;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.getCell(2).font = headerFont;
    row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } };
    row.height = 26;

    (report.transcript || []).forEach((m, i) => {
      const isAgent = m.role === 'agent';
      row = ws3.addRow([isAgent ? 'Agent' : 'Client', m.text]);
      row.getCell(1).font = { name: 'Calibri', bold: true, size: 10, color: { argb: isAgent ? BLUE : AMBER } };
      row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? LGRAY : WHITE } };
      row.getCell(1).border = thinBorder;
      row.getCell(1).alignment = { horizontal: 'center', vertical: 'top' };
      row.getCell(2).font = valueFont;
      row.getCell(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 === 0 ? LGRAY : WHITE } };
      row.getCell(2).border = thinBorder;
      row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    });

    // Generate and send
    const buf = await wb.xlsx.writeBuffer();
    const filename = report.ticket_id + '-report.xlsx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(Buffer.from(buf));
  } catch (err) {
    console.error('[excel-download]', err);
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
