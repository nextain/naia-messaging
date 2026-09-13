/** 조건 스크립트의 직전 관측. 기기 지역 상태라 저장소 밖에 둔다. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = process.env.NAIA_GATE_STATE_DIR
  || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'naia', 'gates');

const fileFor = (name) => path.join(base, `${name}.json`);

export function read(name) {
  try { return JSON.parse(fs.readFileSync(fileFor(name), 'utf8')); }
  catch { return {}; }
}

export function write(name, value) {
  fs.mkdirSync(base, { recursive: true });
  const file = fileFor(name);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}
