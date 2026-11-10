/**
 * 운영자 설정 파일 server.json (SERVER_DESIGN 3.7, 리드 결정 S3-8): 서버가 시작할 때와 `wook-server config reload` 때 읽는다. 기본 자리는
 * `<dataDir>/server.json`(`--config`로 바꾼다). 비밀 값은 넣지 않는다 — 보안 비밀은 `wook-server secret set`으로 OS 보안 저장소에 넣는다.
 * - 파일 값이 DB 값과 다르면 파일 값이 덮어쓰고, 덮어쓴 것마다 활동 기록(행위자 operator)에 남는다 (백엔드 operator.applyServerConfig). 칸이 없거나
 *   null이면 DB 값을 그대로 둔다
 * - 이 단계가 적용하는 칸: owner.email(대표 이메일 — `--owner-email`이 있으면 그것이 먼저, S3-6), google.clientId(서버의 기기 코드 로그인 클라이언트),
 *   cli.claudePath·cli.codexPath(CLI 실행 파일 위치), network.publicOrigin(공개 주소 — `--public-origin`이 있으면 그것이 먼저, Host·Origin 허용에 더한다)과
 *   owner.tailscaleLogins(받는 Tailscale 사용자 — 비면 검사하지 않는다) (S3-7). 공개 주소와 Tailscale 사용자는 HTTP가 요청마다 읽으므로 reload가 바로 바꾼다
 * - 바뀐 것 알리기 (리드 결정 S3-19): 시작과 reload는 공개 주소·Tailscale 사용자도 앞서 쓰던 값(백엔드 kv `server.access`)과 견줘, 바뀐 것마다 답의
 *   ServerConfigChange·활동 기록(operator)·서버 기록 한 줄을 남긴다(Tailscale 사용자는 켬·끔과 수만). 파일을 지우면 파일이 주던 값은 꺼진다.
 *   명령 줄 인자(--owner-email·--public-origin)가 덮는 파일 값은 쓰지 않는다고 경고에 적는다
 * - 메인 자리 seat (리드 결정 S4-12): holders(앉을 수 있는 보유자)·drainMs(교체 때 마무리를 기다리는 시간)는 시작과 reload 때 자리 정책으로 적용하고,
 *   initialHolder(처음 보유자)는 자리가 비었을 때만 쓴다 — 새 DB의 시작 때(serve.ts가 백엔드에 넘긴다). 앉은 자리는 설정을 바꿔도 그대로다. 외부 보유자는
 *   처음 보유자로 둘 수 없다(S4-1 — 시작·reload를 거부한다)
 * - 모양만 보고 아직 적용하지 않는 칸: network.bind·port(서버 인자 --bind·--port로)
 * - 작업 폴더 위치 workspaceRoot (리드 결정 S5-20): 서버를 시작할 때만 읽는다(--workspace-root가 먼저, serve.ts) — reload는 다시 시작해야 바뀐다고 경고한다
 * - 화면 조작 screen.enabled (리드 결정 S6-11): false면 메인 에이전트의 화면 도구를 쓰지 않는다(화면 도우미를 띄우지 않는다). 서버를 시작할 때만 읽는다 —
 *   reload는 다시 시작해야 바뀐다고 경고한다. 참·거짓만 받는다
 * - 모르는 칸은 경고로 알린다(시작은 막지 않는다). 비밀 값처럼 보이는 칸은 쓰지 않고 경고한다. 모양이 틀린 파일은 시작을 막고, reload는 거부해
 *   지금 값을 그대로 둔다 — 모든 값을 먼저 확인한 뒤에만 바꾼다. JSON이 아니면 틀린 자리(줄·글자)만 말하고 파일 내용은 옮기지 않는다 (S3-26).
 *   시작 때는 칸의 모양과 함께 적용할 값(대표 이메일·구글 클라이언트 ID·CLI 위치, --owner-email)도 실행 잠금·백엔드보다 먼저 본다 (precheckServerConfig, S3-35)
 * - `config owner-email`·`config google-client-id`는 이 파일의 그 칸을 바꿔 쓰고(그 사용자만 읽는 파일, 3.7 0600) 다시 읽는다 — 파일이 늘 운영자의 값이다
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { BackendError, type BackendOperator, type SeatConfigValues, type ServerAuthStatus, type ServerConfigChange, type ServerConfigValues } from '../main/backend/types';
import type { Logger } from '../main/shell/logger';
import { isGoogleClientId, normalizeOwnerEmail, serverConfigValueError } from '../main/orchestrator/serverLogin';
import { chooseWorkspaceRoot, mainWorkDirOf, type WorkspaceChoice, type WorkspaceSource } from '../main/orchestrator/mainWork';
import { writePrivateFile } from './admin';
import { parsePublicOrigin } from './sessions';

export const SERVER_CONFIG_FILE = 'server.json';
/** 파일 크기 상한 — 운영자 설정은 작다 */
const MAX_CONFIG_BYTES = 256 * 1024;

export function serverConfigPath(dataDir: string): string {
  return join(dataDir, SERVER_CONFIG_FILE);
}

/** 읽은 server.json (없는 칸은 null) */
export interface ServerConfigFile {
  owner: { email: string | null; tailscaleLogins: string[] | null };
  google: { clientId: string | null };
  cli: { claudePath: string | null; codexPath: string | null };
  network: { bind: string | null; port: number | null; publicOrigin: string | null };
  /** 메인 자리 (리드 결정 S4-12) — 칸이 없으면 null. 값(보유자 표기·범위)은 serverConfigValueError가 본다 */
  seat: SeatConfigValues | null;
  workspaceRoot: string | null;
  /** 화면 조작 (리드 결정 S6-11) — enabled가 false면 쓰지 않는다. 칸이 없으면 null(쓴다). 서버를 시작할 때만 읽는다 */
  screen: { enabled: boolean | null };
}

export type ServerConfigRead = { ok: true; exists: boolean; config: ServerConfigFile; warnings: string[] } | { ok: false; message: string };

const EMPTY: ServerConfigFile = {
  owner: { email: null, tailscaleLogins: null },
  google: { clientId: null },
  cli: { claudePath: null, codexPath: null },
  network: { bind: null, port: null, publicOrigin: null },
  seat: null,
  workspaceRoot: null,
  screen: { enabled: null },
};

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 비밀 값처럼 보이는 칸 이름 — 쓰지 않고 경고한다 */
const SECRETISH = /secret|password|token|apikey|api_key/i;

class ConfigShapeError extends Error {}

/** JSON 값 → 운영자 설정. 모양이 틀리면 던지고, 모르는 칸·비밀 값 칸은 경고에 더한다 */
export function parseServerConfig(value: unknown): { config: ServerConfigFile; warnings: string[] } {
  const warnings: string[] = [];
  if (!isPlain(value)) throw new ConfigShapeError('server.json은 JSON 객체여야 합니다');
  const section = (name: string, keys: readonly string[]): Record<string, unknown> => {
    const v = value[name];
    if (v === undefined || v === null) return {};
    if (!isPlain(v)) throw new ConfigShapeError(`server.json의 ${name}은(는) 객체여야 합니다`);
    for (const k of Object.keys(v)) {
      if (keys.includes(k)) continue;
      warnings.push(
        SECRETISH.test(k)
          ? `${name}.${k}은(는) 비밀 값처럼 보여 쓰지 않습니다 — 비밀 값은 server.json에 넣지 말고 wook-server secret set으로 넣은 뒤 파일에서 지우세요`
          : `모르는 칸 ${name}.${k}은(는) 쓰지 않습니다`,
      );
    }
    return v;
  };
  const text = (o: Record<string, unknown>, path: string, key: string): string | null => {
    const v = o[key];
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw new ConfigShapeError(`server.json의 ${path}.${key}은(는) 글이어야 합니다`);
    return v.trim() || null;
  };
  for (const k of Object.keys(value)) {
    if (['owner', 'google', 'cli', 'network', 'seat', 'workspaceRoot', 'screen'].includes(k)) continue;
    warnings.push(SECRETISH.test(k) ? `${k}은(는) 비밀 값처럼 보여 쓰지 않습니다 — 비밀 값은 wook-server secret set으로 넣으세요` : `모르는 칸 ${k}은(는) 쓰지 않습니다`);
  }
  const owner = section('owner', ['email', 'tailscaleLogins']);
  const logins = owner['tailscaleLogins'];
  if (logins !== undefined && logins !== null && (!Array.isArray(logins) || logins.some((x) => typeof x !== 'string'))) {
    throw new ConfigShapeError('server.json의 owner.tailscaleLogins는 글의 목록이어야 합니다');
  }
  if (Array.isArray(logins) && logins.some((x) => /[\s,]/.test((x as string).trim()))) {
    throw new ConfigShapeError('server.json의 owner.tailscaleLogins에는 Tailscale 사용자 이름(예: owner@example.com)을 하나씩 넣으세요 — 띄어쓰기·쉼표는 쓰지 않습니다');
  }
  const google = section('google', ['clientId']);
  const cli = section('cli', ['claudePath', 'codexPath']);
  const network = section('network', ['bind', 'port', 'publicOrigin']);
  const port = network['port'];
  if (port !== undefined && port !== null && (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535)) {
    throw new ConfigShapeError('server.json의 network.port는 0~65535의 정수여야 합니다');
  }
  // 공개 주소 (S3-7) — 모양이 틀리면 Host·Origin 허용을 넓히지 않고 시작·reload를 막는다
  const originText = text(network, 'network', 'publicOrigin');
  const origin = originText ? parsePublicOrigin(originText) : null;
  if (origin && !origin.ok) throw new ConfigShapeError(`server.json의 network.publicOrigin — ${origin.message}`);
  const seat = value['seat'] === undefined || value['seat'] === null ? null : section('seat', ['initialHolder', 'holders', 'drainMs']);
  const holders = seat?.['holders'];
  if (holders !== undefined && holders !== null && (!Array.isArray(holders) || holders.some((x) => typeof x !== 'string'))) {
    throw new ConfigShapeError('server.json의 seat.holders는 글의 목록이어야 합니다 (예: ["launched:claude", "launched:codex"])');
  }
  const drainMs = seat?.['drainMs'];
  if (drainMs !== undefined && drainMs !== null && typeof drainMs !== 'number') throw new ConfigShapeError('server.json의 seat.drainMs는 숫자(밀리초)여야 합니다');
  const workspaceRoot = value['workspaceRoot'];
  if (workspaceRoot !== undefined && workspaceRoot !== null && typeof workspaceRoot !== 'string') throw new ConfigShapeError('server.json의 workspaceRoot는 글이어야 합니다');
  // 화면 조작 끄기 (리드 결정 S6-11) — 참·거짓만 받는다. "false" 같은 글을 켬으로 읽지 않게 모양이 틀리면 시작·reload를 막는다
  const screen = section('screen', ['enabled']);
  const screenEnabled = screen['enabled'];
  if (screenEnabled !== undefined && screenEnabled !== null && typeof screenEnabled !== 'boolean') {
    throw new ConfigShapeError('server.json의 screen.enabled는 true나 false여야 합니다 (따옴표 없이)');
  }
  return {
    config: {
      owner: { email: text(owner, 'owner', 'email'), tailscaleLogins: Array.isArray(logins) ? (logins as string[]).map((x) => x.trim()).filter(Boolean) : null },
      google: { clientId: text(google, 'google', 'clientId') },
      cli: { claudePath: text(cli, 'cli', 'claudePath'), codexPath: text(cli, 'cli', 'codexPath') },
      network: { bind: text(network, 'network', 'bind'), port: typeof port === 'number' ? port : null, publicOrigin: origin?.ok ? origin.origin : null },
      seat: seat
        ? {
            initialHolder: text(seat, 'seat', 'initialHolder'),
            holders: Array.isArray(holders) ? (holders as string[]).map((x) => x.trim()) : null,
            drainMs: typeof drainMs === 'number' ? drainMs : null,
          }
        : null,
      workspaceRoot: typeof workspaceRoot === 'string' ? workspaceRoot.trim() || null : null,
      screen: { enabled: typeof screenEnabled === 'boolean' ? screenEnabled : null },
    },
    warnings,
  };
}

/**
 * JSON이 아닌 글에서 처음 틀린 자리 (0부터 센 글자 자리 — 글이 중간에 끝났으면 글 길이). JSON 문법(RFC 8259)대로 앞에서부터 읽는다. 틀린 곳을 찾지
 * 못하면(파서와 다르게 봄, 너무 깊은 중첩) null. 글 내용은 돌려주지 않는다 (S3-26)
 */
export function jsonErrorOffset(text: string): number | null {
  const n = text.length;
  let i = 0;
  const fail = (): never => {
    throw new JsonOffset(i);
  };
  const ws = (): void => {
    while (i < n && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n' || text[i] === '\r')) i++;
  };
  const str = (): void => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        return;
      }
      if (c < 0x20) fail();
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) fail();
          i += 6;
        } else if (e !== undefined && '"\\/bfnrt'.includes(e)) i += 2;
        else fail();
        continue;
      }
      i++;
    }
    fail();
  };
  const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
  const value = (): void => {
    ws();
    const c = text[i];
    if (c === '{' || c === '[') {
      const close = c === '{' ? '}' : ']';
      i++;
      ws();
      if (text[i] === close) {
        i++;
        return;
      }
      for (;;) {
        if (c === '{') {
          ws();
          if (text[i] !== '"') fail();
          str();
          ws();
          if (text[i] !== ':') fail();
          i++;
        }
        value();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        if (text[i] === close) {
          i++;
          return;
        }
        fail();
      }
    }
    if (c === '"') return str();
    NUMBER.lastIndex = i;
    if (NUMBER.exec(text)) {
      i = NUMBER.lastIndex;
      return;
    }
    for (const word of ['true', 'false', 'null']) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    fail();
  };
  try {
    value();
    ws();
    if (i < n) fail();
    return null;
  } catch (error) {
    if (error instanceof JsonOffset) return Math.min(error.offset, n);
    return null;
  }
}

class JsonOffset {
  constructor(readonly offset: number) {}
}

/** 틀린 자리를 사람이 읽는 글로 — 줄과 글자(1부터)만, 파일 내용은 옮기지 않는다 (S3-26) */
function jsonErrorWhere(text: string): string {
  const at = jsonErrorOffset(text);
  if (at === null) return '틀린 곳을 찾지 못했습니다 — JSON 검사 도구로 파일을 확인하세요';
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  const column = at - (before.lastIndexOf('\n') + 1) + 1;
  return at >= text.length
    ? `${line}번째 줄 ${column}번째 글자에서 글이 끝났습니다 — 닫는 괄호나 따옴표가 빠졌는지 확인하세요`
    : `${line}번째 줄 ${column}번째 글자 근처를 확인하세요 (글은 따옴표로 감싸야 합니다)`;
}

/** 파일 읽기 — 없으면 빈 설정, 읽지 못하거나 모양이 틀리면 ok false와 그 까닭 */
export function readServerConfig(path: string): ServerConfigRead {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: true, exists: false, config: EMPTY, warnings: [] };
    return { ok: false, message: `운영자 설정 파일(${path})을 읽지 못했습니다: ${code ?? String(error)}` };
  }
  if (Buffer.byteLength(raw) > MAX_CONFIG_BYTES) return { ok: false, message: `운영자 설정 파일(${path})이 너무 큽니다` };
  let value: unknown;
  const text = raw.replace(/^﻿/, '');
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse의 글은 파일 내용을 옮겨 적는다(Node 20부터 틀린 곳 앞뒤 글자) — 따옴표 없이 붙여 넣은 비밀 값이 관리 채널 답·서버 기록·stderr에 남지
    // 않게 자리(줄·글자)만 말한다 (리드 결정 S3-26)
    return { ok: false, message: `운영자 설정 파일(${path})이 JSON이 아닙니다: ${jsonErrorWhere(text)}` };
  }
  try {
    const { config, warnings } = parseServerConfig(value);
    return { ok: true, exists: true, config, warnings };
  } catch (error) {
    if (error instanceof ConfigShapeError) return { ok: false, message: `운영자 설정 파일(${path}) — ${error.message}` };
    throw error;
  }
}

/** config show의 답 — 비밀 값은 등록 여부만 */
export interface ServerConfigView extends ServerAuthStatus {
  path: string;
  exists: boolean;
  /** 마지막으로 읽은 때 (ISO, 아직 읽지 않았으면 null) */
  loadedAt: string | null;
  /** 서버를 --owner-email로 띄웠는지 — 그러면 대표 이메일은 그 인자가 먼저다 */
  ownerEmailFlag: boolean;
  /** 접속 허용 (S3-7): 공개 주소와 정한 곳(--public-origin·server.json), 받는 Tailscale 사용자(없으면 검사하지 않음) */
  access: { publicOrigin: string | null; publicOriginSource: 'flag' | 'config' | null; tailscaleLogins: readonly string[] | null };
  /** 파일에 적힌 값 가운데 아직 적용하지 않는 칸 (서버 인자로 정하는 bind·port) */
  pending: { network: { bind: string | null; port: number | null } };
  /** 이 서버가 쓰는 작업 폴더 위치와 메인 에이전트 작업 폴더, 정한 곳 — 시작할 때만 정한다 (리드 결정 S5-20). 모르면(시험) null */
  workspace: { root: string; mainDir: string; source: WorkspaceSource } | null;
  /** 파일의 메인 자리 처음 보유자 (없으면 null) — 자리가 비었을 때만 쓴다 (S4-12) */
  initialHolder: string | null;
  warnings: string[];
}

export interface OperatorConfigResult {
  changes: ServerConfigChange[];
  warnings: string[];
}

export interface OperatorConfig {
  readonly path: string;
  /** 읽고 적용한다 (시작 때와 config reload). 파일이 틀리면 BackendError('invalid') — 아무것도 바꾸지 않는다 */
  reload(): OperatorConfigResult;
  show(): ServerConfigView;
  /** config owner-email: 파일의 owner.email을 바꿔 쓰고 다시 읽는다 */
  setOwnerEmail(email: string): OperatorConfigResult;
  /** config google-client-id: 파일의 google.clientId를 바꿔 쓰고 다시 읽는다 */
  setGoogleClientId(clientId: string): OperatorConfigResult;
  /** 지금 공개 주소 (S3-7) — --public-origin이 먼저, 없으면 마지막으로 읽은 server.json의 network.publicOrigin. HTTP가 요청마다 읽는다 */
  publicOrigin(): string | null;
  /** 받는 Tailscale 사용자 (S3-7) — 마지막으로 읽은 server.json의 owner.tailscaleLogins, 없거나 비면 null(검사하지 않음) */
  tailscaleLogins(): readonly string[] | null;
}

export interface OperatorConfigOptions {
  path: string;
  /** --owner-email (없으면 null) — 파일의 owner.email보다 먼저다 */
  ownerEmailFlag: string | null;
  /** --public-origin (정리한 주소, 없으면 null) — 파일의 network.publicOrigin보다 먼저다 (S3-7) */
  publicOriginFlag?: string | null;
  /** 서버가 시작할 때 정한 작업 폴더 위치 (리드 결정 S5-20) — reload는 바꾸지 않고, 파일 값이 다르면 다시 시작해야 바뀐다고 경고한다. 없으면(시험) 보지 않는다 */
  workspace?: WorkspaceChoice;
  /**
   * 서버가 시작할 때 읽은 screen.enabled (리드 결정 S6-11 — 화면 조작은 시작할 때만 켜고 끈다). reload는 바꾸지 않고, 파일 값이 달라졌으면 다시 시작해야 바뀐다고
   * 경고한다. 넘기지 않으면(시험) 보지 않는다
   */
  screenEnabledAtStart?: boolean | null;
  operator: Pick<BackendOperator, 'applyServerConfig' | 'serverConfigState'>;
  logger: Logger;
  now?: () => number;
}

/** 서버를 띄운 명령 줄 인자 가운데 파일 값보다 먼저인 것 (S3-6·S3-7) */
export interface ServerConfigFlags {
  /** --owner-email (없으면 null) */
  ownerEmail: string | null;
  /** --public-origin (정리한 주소, 없으면 null) */
  publicOrigin?: string | null;
}

/** 읽은 파일과 명령 줄 인자 → 백엔드에 적용할 값 (operator.applyServerConfig). 시작의 미리 보기도 같은 값을 본다 (S3-35) */
export function serverConfigValues(c: ServerConfigFile, flags: ServerConfigFlags): ServerConfigValues {
  const values: ServerConfigValues = {};
  if (flags.ownerEmail) values.ownerEmail = { email: flags.ownerEmail, source: 'flag' };
  else if (c.owner.email) values.ownerEmail = { email: c.owner.email, source: 'config' };
  if (c.google.clientId) values.googleClientId = c.google.clientId;
  if (c.cli.claudePath || c.cli.codexPath) values.cli = { ...(c.cli.claudePath ? { claudePath: c.cli.claudePath } : {}), ...(c.cli.codexPath ? { codexPath: c.cli.codexPath } : {}) };
  // 메인 자리 정책 (S4-12) — 칸이 없으면 지금 값 그대로
  if (c.seat) values.seat = { ...c.seat };
  // 접속 허용은 HTTP가 이 설정에서 읽는다 — 백엔드는 앞서 쓰던 값과 견줘 바뀐 것만 남긴다 (S3-19). 공개 주소는 --public-origin이 먼저다
  values.access = {
    publicOrigin: flags.publicOrigin ? { origin: flags.publicOrigin, source: 'flag' } : c.network.publicOrigin ? { origin: c.network.publicOrigin, source: 'config' } : null,
    tailscaleLogins: c.owner.tailscaleLogins,
  };
  return values;
}

/** 활동 기록·글에 쓰는 설정 파일 이름 — 파일이 없으면 그렇다고 */
const originOf = (exists: boolean): string => (exists ? SERVER_CONFIG_FILE : `${SERVER_CONFIG_FILE}(파일 없음)`);

/**
 * 서버 시작의 미리 보기 (SERVER_DESIGN 3.7, 리드 결정 S3-35): 실행 잠금·백엔드(저장소·재시작 복구)를 만들기 전에 파일의 모양(readServerConfig)과 적용할
 * 값의 모양(serverConfigValueError — 대표 이메일·구글 클라이언트 ID·CLI 위치, --owner-email 포함)을 본다. 틀리면 그 까닭(값이 온 곳을 말한다).
 * 맞아도 적용은 백엔드가 뜬 뒤다(reload — 같은 확인을 다시 한다)
 */
export function precheckServerConfig(path: string, flags: ServerConfigFlags): { ok: true } | { ok: false; message: string } {
  const r = readServerConfig(path);
  if (!r.ok) return r;
  const invalid = serverConfigValueError(serverConfigValues(r.config, flags), originOf(r.exists));
  return invalid ? { ok: false, message: invalid } : { ok: true };
}

export function createOperatorConfig(o: OperatorConfigOptions): OperatorConfig {
  const now = o.now ?? Date.now;
  let last: { exists: boolean; config: ServerConfigFile; warnings: string[]; at: number } | null = null;

  const valuesOf = (c: ServerConfigFile): ServerConfigValues => serverConfigValues(c, { ownerEmail: o.ownerEmailFlag, publicOrigin: o.publicOriginFlag ?? null });

  /** 명령 줄 인자가 덮어 쓰지 않는 파일 값 — 답과 시작 기록에 그렇다고 말한다 (S3-19) */
  const ignoredByFlags = (c: ServerConfigFile): string[] => [
    ...(o.ownerEmailFlag && c.owner.email ? ['server.json의 owner.email은 쓰지 않습니다 — 서버를 --owner-email로 시작해 그 인자의 대표 이메일이 먼저입니다'] : []),
    ...(o.publicOriginFlag && c.network.publicOrigin ? ['server.json의 network.publicOrigin은 쓰지 않습니다 — 서버를 --public-origin으로 시작해 그 인자의 공개 주소가 먼저입니다'] : []),
    ...workspaceWarnings(c),
    ...screenWarnings(c),
  ];

  /** 화면 조작은 시작할 때만 켜고 끈다 (리드 결정 S6-11) — 파일 값이 시작 때와 달라졌으면 다시 시작해야 바뀐다고 말한다 */
  const screenWarnings = (c: ServerConfigFile): string[] => {
    if (o.screenEnabledAtStart === undefined) return [];
    const was = o.screenEnabledAtStart !== false;
    const next = c.screen.enabled !== false;
    return was === next ? [] : [`server.json의 screen.enabled(화면 조작 ${next ? '켬' : '끔'})는 서버를 다시 시작해야 바뀝니다 — 지금은 화면 조작이 ${was ? '켜져' : '꺼져'} 있습니다`];
  };

  /** 작업 폴더 위치는 시작할 때만 정한다 (리드 결정 S5-20) — 파일 값이 지금 쓰는 위치와 다르면 다시 시작해야 바뀐다고, 인자가 먼저면 그렇다고 말한다 */
  const workspaceWarnings = (c: ServerConfigFile): string[] => {
    const ws = o.workspace;
    if (!ws) return [];
    if (ws.source === 'flag') return c.workspaceRoot ? ['server.json의 workspaceRoot는 쓰지 않습니다 — 서버를 --workspace-root로 시작해 그 인자의 위치가 먼저입니다'] : [];
    const next = chooseWorkspaceRoot(null, c.workspaceRoot);
    if (!isAbsolute(next.root)) return [`server.json의 workspaceRoot가 절대 경로가 아닙니다 (${next.root}) — 이대로면 다음 시작이 거부됩니다`];
    return resolve(next.root) === resolve(ws.root)
      ? []
      : [`server.json의 workspaceRoot(작업 폴더 위치)는 서버를 다시 시작해야 바뀝니다 — 지금은 ${mainWorkDirOf(resolve(ws.root))}에서 일하고, 다시 시작하면 ${mainWorkDirOf(resolve(next.root))}로 옮깁니다`];
  };

  const reload = (): OperatorConfigResult => {
    const r = readServerConfig(o.path);
    if (!r.ok) throw new BackendError('invalid', `${r.message} — 아무것도 바꾸지 않았습니다`);
    // 파일이 없으면 파일이 주던 값(공개 주소·Tailscale 사용자)은 꺼진 것이다 — 바뀐 것으로 알린다 (S3-19)
    const changes = o.operator.applyServerConfig(valuesOf(r.config), originOf(r.exists));
    const warnings = [...r.warnings, ...ignoredByFlags(r.config)];
    last = { exists: r.exists, config: r.config, warnings, at: now() };
    for (const w of warnings) o.logger.warn(`운영자 설정: ${w}`);
    // 바뀐 것마다 한 줄 (S3-19) — 글에 비밀 값은 없다(Tailscale 사용자는 수만)
    for (const c of changes) o.logger.info(`운영자 설정 바뀜 (${c.item}): ${c.text}`);
    o.logger.info(`운영자 설정(${r.exists ? o.path : '파일 없음'})을 읽었습니다 — 바꾼 것 ${changes.length}개${changes.length ? `: ${changes.map((c) => c.item).join(', ')}` : ''}`);
    return { changes, warnings };
  };

  const publicOrigin = (): string | null => o.publicOriginFlag || last?.config.network.publicOrigin || null;
  const tailscaleLogins = (): readonly string[] | null => {
    const list = last?.config.owner.tailscaleLogins;
    return list && list.length ? list : null;
  };

  /** 파일의 한 칸을 바꿔 쓴다 — 파일이 지금 읽히지 않으면 바꿔 쓰지 않는다(운영자가 고칠 내용을 덮지 않게) */
  const writeField = (section: 'owner' | 'google', key: string, value: string): void => {
    let raw: Record<string, unknown> = {};
    if (existsSync(o.path)) {
      const r = readServerConfig(o.path);
      if (!r.ok) throw new BackendError('invalid', `${r.message} — 파일을 고친 뒤 다시 하세요 (바꿔 쓰지 않았습니다)`);
      raw = JSON.parse(readFileSync(o.path, 'utf8').replace(/^﻿/, '')) as Record<string, unknown>;
    }
    const prev = isPlain(raw[section]) ? (raw[section] as Record<string, unknown>) : {};
    raw[section] = { ...prev, [key]: value };
    writePrivateFile(o.path, `${JSON.stringify(raw, null, 2)}\n`, '운영자 설정 파일', o.logger);
  };

  return {
    path: o.path,
    reload,
    show() {
      const c = last?.config ?? EMPTY;
      const origin = publicOrigin();
      return {
        ...o.operator.serverConfigState(),
        path: o.path,
        exists: last?.exists ?? existsSync(o.path),
        loadedAt: last ? new Date(last.at).toISOString() : null,
        ownerEmailFlag: o.ownerEmailFlag !== null,
        access: { publicOrigin: origin, publicOriginSource: origin === null ? null : o.publicOriginFlag ? 'flag' : 'config', tailscaleLogins: tailscaleLogins() },
        pending: { network: { bind: c.network.bind, port: c.network.port } },
        workspace: o.workspace ? { root: resolve(o.workspace.root), mainDir: mainWorkDirOf(resolve(o.workspace.root)), source: o.workspace.source } : null,
        initialHolder: c.seat?.initialHolder ?? null,
        warnings: last?.warnings ?? [],
      };
    },
    publicOrigin,
    tailscaleLogins,
    setOwnerEmail(email) {
      if (o.ownerEmailFlag) {
        throw new BackendError('conflict', '이 서버는 --owner-email로 시작해 대표 이메일을 그 인자로 정합니다 — 바꾸려면 그 인자를 빼거나 바꿔 서버를 다시 시작하세요');
      }
      const value = normalizeOwnerEmail(email);
      // 넣은 값은 글에 되풀이하지 않는다 — 관리 채널이 거부 글을 서버 기록에 남긴다(명령 뒤 낱말은 기록하지 않는다)
      if (!value) throw new BackendError('invalid', '대표 이메일 모양이 아닙니다 — 대표가 로그인할 구글 계정의 이메일을 넣으세요');
      writeField('owner', 'email', value);
      return reload();
    },
    setGoogleClientId(clientId) {
      const value = typeof clientId === 'string' ? clientId.trim() : '';
      if (!isGoogleClientId(value)) {
        throw new BackendError('invalid', "구글 OAuth 클라이언트 ID 모양(…apps.googleusercontent.com)이 아닙니다 — 구글 클라우드 콘솔의 'TV 및 입력 제한 기기' 클라이언트 ID를 넣으세요");
      }
      writeField('google', 'clientId', value);
      return reload();
    },
  };
}
