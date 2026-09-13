/**
 * JSONL 을 줄 단위로 훑는다.
 *
 * `fs.readFileSync` 로 통째로 읽으면 512MB 넘는 파일에서 문자열 한도로 터진다. codex 의
 * rollout 기록이 실제로 그 크기를 넘었다. 기록은 앞으로 더 커지므로 모든 어댑터가 이 함수를
 * 쓴다.
 */
import fs from 'node:fs';

const CHUNK = 4 * 1024 * 1024;

/** `onLine(line)` 이 false 를 돌려주면 거기서 멈춘다. */
export function forEachLine(file, onLine) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let rest = '';
    let read;
    while ((read = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      const text = rest + buf.toString('utf8', 0, read);
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        if (onLine(line) === false) return;
      }
    }
    if (rest && onLine(rest) === false) return;
  } finally { fs.closeSync(fd); }
}
