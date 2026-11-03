'use strict';
// Admin-only MFA: RFC 6238 TOTP + single-use recovery codes and revocable 30-day device trust.
// No game-day assumptions. State is isolated by each portal's /state volume.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const STATE_PATH = process.env.HOCKEY_ADMIN_MFA_FILE || '/state/hockey-admin-mfa.json';
const TRUST_COOKIE = '__Host-hockey_mfa_trust';
const TRUST_DAYS = 30;
const STEP_SECONDS = 30;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(input) {
  let bits=0, value=0, result='';
  for (const byte of input) {
    value=(value<<8)|byte; bits+=8;
    while (bits>=5) { result += B32[(value>>>(bits-=5))&31]; }
  }
  if (bits>0) result+=B32[(value<<(5-bits))&31];
  return result;
}
function b32decode(value) {
  if (!/^[A-Z2-7]+$/.test(value)) throw new Error('Invalid base32 secret');
  let bits=0, acc=0, bytes=[];
  for (const c of value) {
    acc=(acc<<5)|B32.indexOf(c); bits+=5;
    if (bits>=8) { bytes.push((acc>>>(bits-=8))&255); }
  }
  return Buffer.from(bytes);
}
function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function safeHexEqual(a,b) {
  if (!/^[0-9a-f]{64}$/.test(a||'') || !/^[0-9a-f]{64}$/.test(b||'')) return false;
  return crypto.timingSafeEqual(Buffer.from(a,'hex'),Buffer.from(b,'hex'));
}
function totp(secret, counter) {
  const b=Buffer.alloc(8); b.writeBigUInt64BE(BigInt(counter));
  const h=crypto.createHmac('sha1', b32decode(secret)).update(b).digest();
  const offset=h[h.length-1]&0x0f;
  return ((h.readUInt32BE(offset)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
function getCookie(req,name) {
  const raw=String(req.headers.cookie||'');
  const chunk=raw.split(';').map(v=>v.trim()).find(v=>v.startsWith(name+'='));
  return chunk ? chunk.slice(name.length+1) : '';
}
function clearCookie(res) {
  res.setHeader('Set-Cookie', `${TRUST_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`);
}
class HockeyAdminMfa {
  constructor(file=STATE_PATH) {
    this.file=file;
    this.state={ version:1, enabled:false, secret:null, pending:null,
      lastUsedStep:-1, recoveryHashes:[], trusted:{} };
    if (fs.existsSync(file)) {
      const stat=fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('MFA state file is unsafe');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if (data.version!==1 || typeof data.enabled!=='boolean' ||
          !data.trusted || typeof data.trusted!=='object' ||
          !Array.isArray(data.recoveryHashes)) throw new Error('Invalid MFA state');
      this.state=data;
      if (data.enabled && !/^[A-Z2-7]{32}$/.test(data.secret||'')) throw new Error('MFA secret invalid');
    }
  }
  save() {
    fs.mkdirSync(path.dirname(this.file),{recursive:true,mode:0o700});
    const temp=`${this.file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(this.state), {mode:0o600,flag:'wx'});
      fs.chmodSync(temp,0o600);
      fs.renameSync(temp,this.file);
    } catch(e) { try{fs.unlinkSync(temp)}catch(_){} throw e; }
  }
  get enabled() { return this.state.enabled===true; }
  status() {
    this.prune();
    return { enabled:this.enabled, recoveryCodesRemaining:this.state.recoveryHashes.length,
      trustedDevices:Object.keys(this.state.trusted).length };
  }
  prune() {
    const now=Date.now();
    for (const [digest,device] of Object.entries(this.state.trusted)) {
      if (!device || Number(device.expiresAt)<now) delete this.state.trusted[digest];
    }
    if (this.state.pending && Number(this.state.pending.expiresAt)<now) this.state.pending=null;
  }
  beginSetup(issuer) {
    if (this.enabled) throw new Error('MFA is already enabled');
    const secret=b32encode(crypto.randomBytes(20));
    this.state.pending={secret, expiresAt:Date.now()+10*60*1000};
    this.save();
    const label=`${issuer}:Administrator`;
    const uri=`otpauth://totp/${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    return {secret,uri, expiresInMinutes:10};
  }
  getMatchingStep(secret,code,last=-1) {
    if (!/^\d{6}$/.test(String(code||''))) return -1;
    const current=Math.floor(Date.now()/1000/STEP_SECONDS);
    for (const t of [current-1,current,current+1]) {
      if (t>last && totp(secret,t)===String(code)) return t;
    }
    return -1;
  }
  confirmSetup(code) {
    const pending=this.state.pending;
    if (this.enabled || !pending || pending.expiresAt<Date.now()) return null;
    const step=this.getMatchingStep(pending.secret,code);
    if (step<0) return null;
    const codes=Array.from({length:8},()=>{
      const h=crypto.randomBytes(12).toString('hex').toUpperCase();
      return h.match(/.{1,6}/g).join('-');
    });
    this.state.enabled=true;
    this.state.secret=pending.secret;
    this.state.pending=null;
    this.state.lastUsedStep=step;
    this.state.recoveryHashes=codes.map(c=>hash(c.replace(/-/g,'')));
    this.state.trusted={};
    this.save();
    return codes;
  }
  verify(code) {
    if (!this.enabled) return false;
    const step=this.getMatchingStep(this.state.secret, code, this.state.lastUsedStep);
    if (step>=0) {
      this.state.lastUsedStep=step; this.save(); return true;
    }
    const normalized=String(code||'').toUpperCase().replace(/[\s-]/g,'');
    if (!/^[A-F0-9]{24}$/.test(normalized)) return false;
    const digest=hash(normalized);
    const idx=this.state.recoveryHashes.findIndex(v=>safeHexEqual(digest,v));
    if (idx<0) return false;
    this.state.recoveryHashes.splice(idx,1); this.save(); return true;
  }
  trust(req,res) {
    this.prune();
    const token=crypto.randomBytes(32).toString('hex');
    const digest=hash(token);
    this.state.trusted[digest]={expiresAt:Date.now()+TRUST_DAYS*86400000,
      uaHash:hash(String(req.headers['user-agent']||'')), createdAt:Date.now()};
    const entries=Object.entries(this.state.trusted).sort((a,b)=>b[1].createdAt-a[1].createdAt);
    this.state.trusted=Object.fromEntries(entries.slice(0,20));
    this.save();
    res.setHeader('Set-Cookie', `${TRUST_COOKIE}=${token}; Path=/; Max-Age=${TRUST_DAYS*86400}; HttpOnly; Secure; SameSite=Strict`);
  }
  isTrusted(req) {
    if (!this.enabled) return false;
    const token=getCookie(req,TRUST_COOKIE);
    if (!/^[0-9a-f]{64}$/.test(token)) return false;
    const candidate=hash(token);
    // Don't expose whether the device has an entry by unbounded string compare.
    const device=this.state.trusted[candidate];
    return !!device && Number(device.expiresAt)>Date.now() &&
      safeHexEqual(device.uaHash,hash(String(req.headers['user-agent']||'')));
  }
  revokeTrusted(res) { this.state.trusted={}; this.save(); clearCookie(res); }
  disable(res) {
    this.state={ version:1,enabled:false,secret:null,pending:null,
      lastUsedStep:-1,recoveryHashes:[],trusted:{} };
    this.save(); clearCookie(res);
  }
}
module.exports={HockeyAdminMfa,totp,b32encode,b32decode};
