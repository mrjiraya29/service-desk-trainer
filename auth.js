// auth.js
// Password hashing, JWT issuance/verification, and Express middleware for
// protecting routes and separating user vs admin access.

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_COOKIE = 'sdt_token';
const TOKEN_TTL = '8h';

if (!JWT_SECRET) {
  console.warn('[auth] JWT_SECRET is not set. Set it to a long random string before deploying.');
}

function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}

function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    JWT_SECRET || 'dev-secret-change-me',
    { expiresIn: TOKEN_TTL }
  );
}

function setAuthCookie(res, token) {
  res.cookie(TOKEN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 8 * 60 * 60 * 1000
  });
}

function clearAuthCookie(res) {
  res.clearCookie(TOKEN_COOKIE);
}

/** Populates req.user if a valid token is present; never blocks the request. */
function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[TOKEN_COOKIE];
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET || 'dev-secret-change-me');
    } catch (e) {
      req.user = null;
    }
  }
  next();
}

/** Blocks the request unless a valid session is present. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

/** Blocks the request unless the signed-in user is an admin. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required.' });
  next();
}

module.exports = {
  hashPassword, verifyPassword, issueToken, setAuthCookie, clearAuthCookie,
  attachUser, requireAuth, requireAdmin, TOKEN_COOKIE
};