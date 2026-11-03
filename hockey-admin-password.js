'use strict';
// Admin credential rotation. One isolated credential state file per portal's persistent /state volume.
// The original Docker Admin secret is a bootstrap fallback only until first password rotation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCRYPT_OPTIONS = Object.freeze({N:16384, r:8, p:1, maxmem:64*1024*1024});
const CREDENTIAL_FILE = process.env.HOCKEY_ADMIN_CREDENTIAL_FILE || '/state/hockey-admin-credential.json';
// Standby Render deployments can explicitly use the Render environment password.
const ENV_PASSWORD_ONLY = process.env.HOCKEY_ADMIN_ENV_PASSWORD_ONLY === 'true';

function validNewPassword(password) {
  return typeof password === 'string' && password.length >= 12 &&
    password.length <= 128 && password.trim() === password &&
    !/[\u0000-\u001f\u007f]/.test(password);
}
function derive(password,salt) {
  return crypto.scryptSync(password,Buffer.from(salt,'hex'),64,SCRYPT_OPTIONS);
}
class HockeyAdminPassword {
  constructor(bootstrapPassword,file=CREDENTIAL_FILE) {
    this.bootstrapPassword=String(bootstrapPassword||'');
    this.file=file;
    this.record=null;
    if (!ENV_PASSWORD_ONLY && fs.existsSync(file)) {
      const st=fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink()) throw new Error('Unsafe Admin credential state');
      const data=JSON.parse(fs.readFileSync(file,'utf8'));
      if (data.schema!==1 || !Number.isSafeInteger(data.revision) || data.revision<1 ||
          !/^[0-9a-f]{32}$/.test(data.salt||'') ||
          !/^[0-9a-f]{128}$/.test(data.digest||'')) {
        throw new Error('Invalid Admin credential state; refusing to use bootstrap fallback');
      }
      this.record=data;
    }
  }
  get version() { return this.record ? this.record.revision : 0; }
  isConfigured() { return !!this.record || !!this.bootstrapPassword; }
  verify(password) {
    if (typeof password !== 'string') return false;
    if (!ENV_PASSWORD_ONLY && this.record) {
      const actual=derive(password,this.record.salt);
      return crypto.timingSafeEqual(actual,Buffer.from(this.record.digest,'hex'));
    }
    // Preserve prior Admin login behaviour for existing Docker secret values.
    const supplied=Buffer.from(password.trim(),'utf8');
    const expected=Buffer.from(this.bootstrapPassword,'utf8');
    return !!this.bootstrapPassword && supplied.length===expected.length &&
      crypto.timingSafeEqual(supplied,expected);
  }
  rotate(newPassword) {
    if (ENV_PASSWORD_ONLY) throw new Error('Admin password is managed through Render ADMIN_PASSWORD');
    if (!validNewPassword(newPassword)) throw new Error('Invalid new Admin password');
    if (this.verify(newPassword)) throw new Error('New password must differ from current password');
    const nextRevision=this.version+1;
    const salt=crypto.randomBytes(16).toString('hex');
    const digest=derive(newPassword,salt).toString('hex');
    const record={schema:1,revision:nextRevision,salt,digest,changedAt:new Date().toISOString()};
    const dir=path.dirname(this.file);
    fs.mkdirSync(dir,{recursive:true,mode:0o700});
    const temp=path.join(dir,`.admin-credential-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`);
    try {
      const fd=fs.openSync(temp,'wx',0o600);
      try {
        fs.writeFileSync(fd,JSON.stringify(record)+'\n','utf8');
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temp,this.file);
      fs.chmodSync(this.file,0o600);
      // Do not update in-memory state until the durable file has been saved.
      this.record=record;
    } catch(err) {
      try { fs.unlinkSync(temp); } catch(_) {}
      throw err;
    }
    return nextRevision;
  }
}
module.exports={HockeyAdminPassword,validNewPassword};
