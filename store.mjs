import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const stateFile = /^[2-9A-HJ-NP-Z]{5}\.json$/;

export class RoomStore {
  constructor(directory) {
    this.directory = resolve(directory);
    this.pending = new Map();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }

  read() {
    const saved = [];
    for (const name of readdirSync(this.directory)) {
      if (!stateFile.test(name)) continue;
      try {
        const value = JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
        if (value.code === name.slice(0, 5)) saved.push(value);
      } catch { console.error('Один файл комнаты не удалось восстановить.'); }
    }
    return saved;
  }

  queue(code, operation) {
    const previous = this.pending.get(code) || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.pending.set(code, next);
    next.then(() => { if (this.pending.get(code) === next) this.pending.delete(code); }, () => {
      console.error('Не удалось сохранить состояние одной комнаты.');
    });
    return next;
  }

  save(code, snapshot) {
    const path = join(this.directory, `${code}.json`);
    const temporary = `${path}.tmp`;
    const payload = JSON.stringify(snapshot);
    return this.queue(code, async () => {
      await writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path);
    });
  }

  remove(code) {
    return this.queue(code, async () => {
      await rm(join(this.directory, `${code}.json`), { force: true });
      await rm(join(this.directory, `${code}.json.tmp`), { force: true });
    });
  }

  flush(code) { return this.pending.get(code); }
  finish() { return Promise.allSettled(this.pending.values()); }
}
