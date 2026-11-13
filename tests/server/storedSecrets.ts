/**
 * 빌드한 서버가 넣은 비밀 값을 시험이 읽는다 (리드 결정 S10-6.1). Windows·macOS의 서버는 OS 보안 저장소를 쓰므로 시험은 그것을 가짜(fakeGooglePreload.cjs —
 * 파일 하나, 키 `wookagent\0<계정>`)로 바꾼다. Linux의 서버는 키링을 쓰지 않고 그 데이터 폴더의 파일 저장소(`<dataDir>/secrets/`)를 쓴다 — 시험의 임시
 * 데이터 폴더 안이라 실제 사용자의 것을 건드리지 않는다. 어느 쪽이든 같은 꼴(`wookagent\0<계정>` → 값)로 돌려준다
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { secretsDirOf } from '../../src/main/auth/fileSecretStore';

export function storedSecrets(o: { keyringFile: string; dataDir: string; platform?: NodeJS.Platform }): Record<string, string> {
  if ((o.platform ?? process.platform) !== 'linux') {
    try {
      return JSON.parse(readFileSync(o.keyringFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }
  const dir = secretsDirOf(o.dataDir);
  const out: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^[0-9a-f]{64}\.json$/.test(n)) continue;
    const e = JSON.parse(readFileSync(join(dir, n), 'utf8')) as { account: string; value: string };
    out[`wookagent\u0000${e.account}`] = e.value;
  }
  return out;
}
