import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';

export const sessionKey = value => createHash('sha256').update(value).digest('hex');

// Only remembered sessions are persisted, and only hashes of cookie IDs reach disk.
export class Sessions extends Map {
  constructor(token, file) {
    super();
    this.file = file;
    this.binding = sessionKey(token);
    this.remembered = new Set();
    if (!file) return;
    let saved;
    try { saved = JSON.parse(readFileSync(file, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw new Error(`Cannot read session store: ${file}`, { cause: error }); }
    if (saved.binding !== this.binding) { this.persist(); return; }
    if (!Array.isArray(saved.sessions)) throw new Error('Invalid session store');
    for (const [id, expiry] of saved.sessions) {
      if (/^[a-f0-9]{64}$/.test(id) && Number.isFinite(expiry) && expiry > Date.now()) {
        super.set(id, expiry); this.remembered.add(id);
      }
    }
  }
  create(id, expiry, remember) {
    super.set(id, expiry);
    if (remember) {
      this.remembered.add(id);
      try { this.persist(); }
      catch (error) { super.delete(id); this.remembered.delete(id); throw error; }
    }
  }
  delete(id) {
    const expiry = this.get(id);
    const remembered = this.remembered.delete(id);
    const removed = super.delete(id);
    if (remembered) {
      try { this.persist(); }
      catch (error) { super.set(id, expiry); this.remembered.add(id); throw error; }
    }
    return removed;
  }
  persist() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify({ binding: this.binding, sessions: [...this].filter(([id]) => this.remembered.has(id)) }), { mode: 0o600, flag: 'wx' });
      renameSync(temp, this.file);
    } finally { try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
}
