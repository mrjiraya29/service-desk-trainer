# Setup

## What changed
- The Gemini API key is no longer typed into the browser. It now lives **only** on the backend (`server.js`), which proxies both calls the app needs (`/api/turn` for each client reply, `/api/score` for the end-of-test report). The browser never sees the key.
- The setup screen now uses **dropdowns** for mood and scenario instead of chip buttons. The "write your own scenario" option was removed since you gave a fixed list.
- Scenarios are now exactly: **Network issue, Database issue, App down, Cyber breach (cyber attack)**.
- The model used is `gemini-3.1-flash-lite` (set in `server.js`).
- The report screen now has a **Download report** button — it saves a `.txt` file with the overall score, the 4 category scores, the strengths/mistakes list, and the full transcript.
- The scoring prompt was tightened so strengths/improvements must point to an exact line or moment in the agent's messages, not generic advice.

## 1. Add your Gemini API key
Open `server.js` and replace this line with your real key:

```js
const GEMINI_API_KEY = 'PASTE_YOUR_GEMINI_API_KEY_HERE';
```

Get a key at https://aistudio.google.com/apikey

> Keeping the key in `server.js` (not in the HTML) is what actually keeps it private — anything hardcoded into the frontend file is visible to anyone who opens dev tools, so this is the safe version of "static key in code."

## 2. Install and run

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser.

## 3. Deploying somewhere real
Any host that runs a Node process works (Render, Railway, Fly.io, a VPS, etc.) — just make sure `server.js` and `public/` are deployed together, `npm install` runs, and `npm start` boots it. No database is needed.

## Files
- `server.js` — the backend (holds the API key, calls Gemini, exposes `/api/turn` and `/api/score`)
- `public/index.html` — the frontend (setup screen, chat screen, report screen)
- `package.json` — dependencies (just `express`)
