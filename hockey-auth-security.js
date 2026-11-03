'use strict';
// Phan's Hockey Portal security state. Isolated per deployment's /state volume.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 2;
const MAX_RECORDS = 12000;

function safeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const left = Buffer.from(a, 'utf8');
    const right = Buffer.from(b, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

class HockeyAuthSecurity {
    constructor(file = process.env.HOCKEY_AUTH_SECURITY_FILE || '/state/hockey-auth-security.json') {
        this.file = file;
        this.state = { failures: {}, roles: { goalie: {}, payment: {} }, lockoutEnabled: true };
        if (fs.existsSync(file)) {
            const data = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!data || typeof data !== 'object' || !data.failures || !data.roles) {
                throw new Error('Security state invalid; refusing to start');
            }
            this.state = data;
        }
        // Missing setting in older state files means ON (secure default).
        this.state.lockoutEnabled = this.state.lockoutEnabled !== false;
        for (const role of ['goalie', 'payment']) {
            if (!this.state.roles[role]) this.state.roles[role] = {};
        }
    }
    save() {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const tmp = `${this.file}.${process.pid}.tmp`;
        try {
            fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flag: 'w' });
            fs.chmodSync(tmp, 0o600);
            fs.renameSync(tmp, this.file);
        } catch (e) {
            try { fs.unlinkSync(tmp); } catch (_) { /* ignored */ }
            throw e; // Fail closed if persistent lockout state cannot be written
        }
    }
    ip(req) {
        const val = String(req.ip || req.socket?.remoteAddress || 'unknown');
        return val.startsWith('::ffff:') ? val.slice(7) : val;
    }
    prune(now = Date.now()) {
        for (const [ip, item] of Object.entries(this.state.failures)) {
            if (!item || (!item.lockedUntil && now - Number(item.first || 0) >= WINDOW_MS) ||
                (item.lockedUntil && now >= Number(item.lockedUntil))) {
                delete this.state.failures[ip];
            }
        }
        const names = Object.keys(this.state.failures);
        if (names.length > MAX_RECORDS) {
            names.sort((a, b) => Number(this.state.failures[a]?.first || 0) - Number(this.state.failures[b]?.first || 0));
            for (const ip of names.slice(0, names.length - MAX_RECORDS)) delete this.state.failures[ip];
        }
    }
    check(req, res, next) {
        if (this.state.lockoutEnabled === false) return next();
        const ip = this.ip(req);
        const item = this.state.failures[ip];
        if (item?.lockedUntil && Date.now() < item.lockedUntil) {
            return this.locked(res, item.lockedUntil);
        }
        next();
    }
    locked(res, until) {
        const seconds = Math.max(1, Math.ceil((until - Date.now()) / 1000));
        res.set('Retry-After', String(seconds));
        res.set('Cache-Control', 'no-store');
        return res.status(429).json({ success: false,
            error: 'Too many incorrect passwords from this IP. Locked for 15 minutes.',
            code: 'IP_LOGIN_LOCKED', retryAfterSeconds: seconds });
    }
    fail(req, res) {
        if (this.state.lockoutEnabled === false) {
            return res.status(401).json({success:false,error:'Invalid password or verification code.'});
        }
        const ip = this.ip(req);
        const now = Date.now();
        const prior = this.state.failures[ip];
        const current = prior && now - Number(prior.first || 0) < WINDOW_MS ? prior : { first: now, count: 0 };
        current.count += 1;
        if (current.count >= MAX_FAILURES) current.lockedUntil = now + WINDOW_MS;
        this.state.failures[ip] = current;
        this.prune(now);
        this.save();
        if (current.lockedUntil) return this.locked(res, current.lockedUntil);
        return res.status(401).json({ success: false, error: 'Invalid password. One attempt remaining before 15-minute IP lockout.' });
    }
    success(req) {
        delete this.state.failures[this.ip(req)];
        this.prune();
        this.save();
    }
    setLockoutEnabled(value) {
        if (typeof value !== 'boolean') throw new TypeError('Expected boolean');
        const oldEnabled = this.state.lockoutEnabled;
        const oldFailures = this.state.failures;
        this.state.lockoutEnabled = value;
        this.state.failures = {};
        try { this.save(); } catch(err) {
            this.state.lockoutEnabled = oldEnabled;
            this.state.failures = oldFailures; throw err;
        }
    }
    roleVersion(role) {
        return this.state.roles[role]?.version || 'initial';
    }
    validRolePassword(role, candidate, legacyPassword) {
        const credential = this.state.roles[role];
        if (!credential || typeof candidate !== 'string') return false;
        if (credential.hash && credential.salt) {
            const digest = crypto.scryptSync(candidate, Buffer.from(credential.salt, 'hex'), 64);
            return safeEqual(digest.toString('hex'), credential.hash);
        }
        return !!legacyPassword && safeEqual(candidate.trim(), legacyPassword);
    }
    setRolePassword(role, password) {
        if (!['goalie', 'payment'].includes(role)) throw new Error('Unsupported password role');
        if (typeof password !== 'string' || password.length < 6 || Buffer.byteLength(password) > 256 ||
            password !== password.trim()) throw new Error('Use 6–128 characters without leading or trailing spaces.');
        const salt = crypto.randomBytes(24);
        const hash = crypto.scryptSync(password, salt, 64).toString('hex');
        const previous = { ...this.state.roles[role] };
        this.state.roles[role] = { salt: salt.toString('hex'), hash, version: crypto.randomUUID(), updatedAt: new Date().toISOString() };
        try { this.save(); } catch (err) { this.state.roles[role] = previous; throw err; }
    }
}
module.exports = { HockeyAuthSecurity, safeEqual };
