'use strict';
// Backup security: retain separate goalie/payment role passwords, but NO IP lockout.
// Admin password is exclusively checked in server.js against Render ADMIN_PASSWORD.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
class HockeyAuthSecurity {
  constructor(file = process.env.HOCKEY_AUTH_SECURITY_FILE || './runtime/hockey-auth-security.json') {
    this.file = file;
    this.state = { roles: { goalie: {}, payment: {} } };
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && data.roles && typeof data.roles === 'object') this.state.roles = data.roles;
    }
    for (const role of ['goalie','payment']) {
      if (!this.state.roles[role]) this.state.roles[role] = {};
    }
  }
  check(req, res, next) { return next(); }
  fail(req, res) { return res.status(401).json({success:false,error:'Invalid password.'}); }
  success() { /* no login-attempt state or IP tracking */ }
  save() {
    fs.mkdirSync(path.dirname(this.file), {recursive:true,mode:0o700});
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(this.state), {mode:0o600,flag:'w'});
      fs.renameSync(tmp, this.file);
    } catch (err) {
      try {fs.unlinkSync(tmp);} catch (_) {}
      throw err;
    }
  }
  roleVersion(role) { return this.state.roles[role]?.version || 'initial'; }
  validRolePassword(role, candidate, legacyPassword) {
    const item = this.state.roles[role];
    if (!item || typeof candidate !== 'string') return false;
    if (item.hash && item.salt) {
      const hash = crypto.scryptSync(candidate,Buffer.from(item.salt,'hex'),64).toString('hex');
      return safeEqual(hash,item.hash);
    }
    return !!legacyPassword && safeEqual(candidate.trim(),legacyPassword);
  }
  setRolePassword(role, password) {
    if (!['goalie','payment'].includes(role)) throw new Error('Unsupported password role');
    if (typeof password !== 'string' || password.length < 6 || password.length > 128 ||
        password !== password.trim()) throw new Error('Password must contain 6–128 characters without leading or trailing spaces.');
    const salt = crypto.randomBytes(24);
    const hash = crypto.scryptSync(password,salt,64).toString('hex');
    const old = this.state.roles[role];
    this.state.roles[role] = {salt:salt.toString('hex'),hash,version:crypto.randomUUID(),updatedAt:new Date().toISOString()};
    try { this.save(); } catch(err) { this.state.roles[role]=old; throw err; }
  }
}
module.exports = {HockeyAuthSecurity,safeEqual};
