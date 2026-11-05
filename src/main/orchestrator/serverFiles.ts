/**
 * 서버의 파일 주고받기 (리드 결정 S3-10, SERVER_DESIGN 3.4 '파일'·3.7): 원격 화면이 명령에 붙일 파일을 올리고(업로드), 첨부·보고서·내보내기·화면 캡처를
 * 내려받는다. HTTP 전송(본문 받기·응답 머리)은 src/server/http.ts가 하고, 여기서는 자리와 대상을 정한다.
 * - 업로드: `<dataDir>/uploads/`에 `<업로드 ID>`(파일)와 `<업로드 ID>.json`(이름·크기·올린 기기 세션·때)을 둔다. 50MB까지, 24시간 뒤 지운다(sweep).
 *   업로드 ID는 `up_` + 16바이트 난수(16진수) — 올린 그 기기 세션만 쓸 수 있다
 * - 원격 명령의 첨부(remoteCommand): `uploadId`만 받고(붙여 넣은 그림 dataUrl은 그대로), 서버 PC의 파일 경로(`path`)는 invalid로 거부한다 — 원격 호출자가
 *   서버의 아무 파일이나 명령에 붙여 읽지 못하게 (9.2). 데스크톱 화면은 예전 그대로 경로를 쓴다
 * - 내려받기 대상(download): 첨부(A-…, 첨부 폴더 안), 보고서 파일(R-…, 보고서 폴더 안), 내보내기(내보내기 폴더의 파일 이름), 화면 캡처(6단계 — 아직 없다).
 *   HTTP가 실제 경로를 다시 보고(심볼릭 링크 포함) 그 폴더 밖이면 주지 않는다. 백업은 내려받지 않는다 — 운영 일이다
 * 데스크톱 앱은 이 길을 쓰지 않는다 — 업로드 폴더도 서버가 처음 받을 때 만든다
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Attachment } from '@shared/domain';
import type { SendCommandInput } from '@shared/ipc';
import { BackendError, type RemoteCaller } from '../backend/types';
import type { Core } from './core';

/** 업로드 하나의 상한 (50MB) */
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
/** 올린 파일을 두는 시간 (24시간) */
export const UPLOAD_KEEP_MS = 24 * 60 * 60 * 1000;
export const UPLOADS_DIR = 'uploads';
const UPLOAD_ID_RE = /^up_[0-9a-f]{32}$/;
const ATTACHMENT_ID_RE = /^A-\d{1,12}$/;
const REPORT_ID_RE = /^R-\d{1,12}$/;
/** 내보내기 파일 이름 (logs.export가 만드는 activity-<때>.jsonl 등) — 폴더 구분자·'..' 없이 */
const EXPORT_NAME_RE = /^(?!\.)[A-Za-z0-9._-]{1,200}$/;

/** 원격 명령에 서버 PC의 파일 경로를 붙였을 때 (S3-10) */
export const REMOTE_PATH_REFUSED = '서버에 접속한 화면은 파일을 경로로 붙일 수 없습니다 — 파일을 올린 뒤(업로드) 그 업로드로 붙이세요';
export const UPLOAD_GONE = '올린 파일을 찾을 수 없습니다 — 24시간이 지났거나 다른 기기에서 올린 파일입니다. 다시 올려 주세요';

export interface UploadRecord {
  id: string;
  /** 정리한 파일 이름 */
  name: string;
  size: number;
  /** 올린 기기 세션 */
  sessionId: string;
  createdAt: string;
}

/** 내려받을 파일: 실제 경로와, 그 파일이 있어야 하는 폴더(HTTP가 실제 경로로 다시 본다) */
export interface DownloadFile {
  path: string;
  root: string;
  /** 받는 쪽에 보일 이름 */
  name: string;
}

export type DownloadKind = 'attachment' | 'report' | 'export' | 'screen';

/** 올린 파일 이름 다듬기: 경로·제어 문자·Windows가 못 쓰는 글자 없이 120자까지, 비면 'file' */
export function cleanUploadName(name: unknown): string {
  const text = typeof name === 'string' ? basename(name.replace(/\\/g, '/')) : '';
  const safe = text.replace(/[<>:"/\\|?*\p{Cc}\p{Zl}\p{Zp}]/gu, '_').trim();
  return [...(safe && safe !== '.' && safe !== '..' ? safe : 'file')].slice(0, 120).join('');
}

export class ServerFiles {
  constructor(private readonly core: Core) {}

  private get ctx() {
    return this.core.ctx;
  }

  /** 업로드 폴더 (`<dataDir>/uploads`) */
  get uploadsDir(): string {
    return join(this.ctx.paths.root, UPLOADS_DIR);
  }

  /** 새 업로드 자리 — 받는 동안 쓸 임시 파일(`<ID>.part`)과 ID */
  beginUpload(): { id: string; tmpPath: string } {
    mkdirSync(this.uploadsDir, { recursive: true });
    const id = `up_${randomBytes(16).toString('hex')}`;
    return { id, tmpPath: join(this.uploadsDir, `${id}.part`) };
  }

  /** 다 받았다 — 제자리로 옮기고 정보를 적는다 */
  finishUpload(o: { id: string; sessionId: string; name: string; size: number }): UploadRecord {
    const dir = this.uploadsDir;
    const record: UploadRecord = { id: o.id, name: cleanUploadName(o.name), size: o.size, sessionId: o.sessionId, createdAt: new Date(this.ctx.clock.ms()).toISOString() };
    renameSync(join(dir, `${o.id}.part`), join(dir, o.id));
    writeFileSync(join(dir, `${o.id}.json`), JSON.stringify(record), 'utf8');
    return record;
  }

  /** 받다 그만둔 업로드의 임시 파일을 지운다 */
  abortUpload(id: string): void {
    if (!UPLOAD_ID_RE.test(id)) return;
    try {
      unlinkSync(join(this.uploadsDir, `${id}.part`));
    } catch {
      // 이미 없다
    }
  }

  /** 그 기기 세션이 올린 살아 있는 업로드 (없거나 24시간이 지났거나 다른 기기 세션이 올렸으면 null) */
  upload(id: unknown, sessionId: string): (UploadRecord & { path: string }) | null {
    if (typeof id !== 'string' || !UPLOAD_ID_RE.test(id)) return null;
    const dir = this.uploadsDir;
    let record: UploadRecord;
    try {
      record = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as UploadRecord;
    } catch {
      return null;
    }
    if (record.id !== id || record.sessionId !== sessionId) return null;
    if (this.ctx.clock.ms() - Date.parse(record.createdAt) >= UPLOAD_KEEP_MS) return null;
    const path = join(dir, id);
    return existsSync(path) ? { ...record, path } : null;
  }

  /** 24시간이 지난 업로드(파일·정보)와 끝내지 못한 임시 파일을 지운다 — 지운 파일 수 */
  sweep(): number {
    const dir = this.uploadsDir;
    if (!existsSync(dir)) return 0;
    const cutoff = this.ctx.clock.ms() - UPLOAD_KEEP_MS;
    let removed = 0;
    for (const f of readdirSync(dir)) {
      const full = join(dir, f);
      try {
        if (statSync(full).mtimeMs >= cutoff) continue;
        unlinkSync(full);
        removed++;
      } catch {
        // 지우는 사이에 없어졌거나 쓰는 중 — 다음 정리에 맡긴다
      }
    }
    return removed;
  }

  /**
   * 원격 명령의 첨부 (S3-10): uploadId는 그 기기 세션이 올린 파일로 바꾸고, 서버 PC의 파일 경로(path)는 거부한다. 붙여 넣은 그림(dataUrl)은 그대로
   */
  remoteCommand(caller: RemoteCaller, input: SendCommandInput): SendCommandInput {
    if (!input.attachments?.length) return input;
    const sessionId = caller.session?.id ?? '';
    const attachments = input.attachments.map((a) => {
      if (a.path) throw new BackendError('invalid', REMOTE_PATH_REFUSED);
      if (a.uploadId) {
        const up = this.upload(a.uploadId, sessionId);
        if (!up) throw new BackendError('not_found', UPLOAD_GONE);
        return { name: a.name || up.name, path: up.path };
      }
      return { name: a.name, ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}) };
    });
    return { ...input, attachments };
  }

  /** 내려받을 파일 (없으면 null) — 화면 캡처는 6단계에 생긴다 */
  download(kind: DownloadKind, id: string): DownloadFile | null {
    const ctx = this.ctx;
    if (kind === 'attachment') {
      if (!ATTACHMENT_ID_RE.test(id)) return null;
      const a = ctx.store.kv.get<Attachment>(`attachment:${id}`);
      return a?.path ? { path: a.path, root: ctx.paths.attachments, name: a.name } : null;
    }
    if (kind === 'report') {
      if (!REPORT_ID_RE.test(id)) return null;
      const r = ctx.store.reports.get(id);
      return r?.filePath ? { path: r.filePath, root: ctx.paths.reports, name: basename(r.filePath) } : null;
    }
    if (kind === 'export') {
      if (!EXPORT_NAME_RE.test(id)) return null;
      return { path: join(ctx.paths.exports, id), root: ctx.paths.exports, name: id };
    }
    return null;
  }
}
