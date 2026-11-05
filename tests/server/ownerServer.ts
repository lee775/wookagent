/**
 * 3단계 HTTP 표면 시험(S3c)의 공용 준비: 서버 모드 하네스 + 등록된 대표 + 프로세스 안 서버 + 그 대표의 기기 세션. 토큰은 시험 출력에 내지 않는다
 */
import { createHarness, type Harness, type HarnessOptions } from '../e2e/harness';
import { startServer, type RunningServer, type StartServerOptions } from '../../src/server/server';
import { memoryLogger, remoteBackendOf } from './helpers';

/** 시험의 등록된 대표 (구글 계정이 있는 대표 — 기기 세션을 낸다) */
export const TEST_OWNER_RECORD = { sub: 'google-owner-sub', email: 'owner@example.com', name: '대표' } as const;

export interface OwnerServer {
  h: Harness;
  server: RunningServer;
  log: ReturnType<typeof memoryLogger>;
  /** 대표의 기기 세션 하나 (Bearer로 쓴다) */
  token: string;
  sessionId: string;
  /** 대표의 기기 세션을 하나 더 */
  issue(deviceName?: string): { token: string; sessionId: string };
  close(): Promise<void>;
}

/** 서버 모드 하네스 + 등록된 대표 + 프로세스 안 서버 + 그 대표의 기기 세션 하나. 하네스·서버 옵션을 더 줄 수 있다 */
export async function ownerServer(o: { harness?: HarnessOptions; server?: Partial<Omit<StartServerOptions, 'backend' | 'dataDir'>> } = {}): Promise<OwnerServer> {
  const h = await createHarness({ noProject: true, ...o.harness, mode: 'server' });
  h.core.ctx.store.kv.set('owner', { ...TEST_OWNER_RECORD, registeredAt: h.core.ctx.now(), lastLoginAt: null });
  const log = memoryLogger();
  const server = await startServer({ backend: remoteBackendOf(h), dataDir: h.dataDir, port: 0, allowTestSession: false, logger: log, version: 'test', ...o.server });
  const issue = (deviceName = '시험 기기'): { token: string; sessionId: string } => {
    const { token, session } = h.core.deviceSessions.issue({ deviceName });
    return { token, sessionId: session.id };
  };
  const first = issue('휴대폰');
  return {
    h,
    server,
    log,
    ...first,
    issue,
    async close() {
      await server.close();
      await h.close();
    },
  };
}
