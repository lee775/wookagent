/**
 * 화면 보기 확인의 시험 이미지 (SERVER_DESIGN 8.3.4, 리드 결정 S6-10). 회색 바탕에 5×7 글꼴로 그린 네 자리 숫자 — 숫자마다 ±4px 흔든다. 새 의존성 없이
 * PNG(8비트 회색, 거르기 0, zlib deflate, 직접 만든 CRC32)를 만든다. 화면 캡처가 아니므로 비밀이 섞이지 않는다.
 *
 * - 숫자(code)는 이 파일 밖에서 메모리에만 둔다 — DB·기록·이벤트·파일 이름·PNG 메타데이터 어디에도 쓰지 않는다. 이 PNG에는 IHDR·IDAT·IEND만 있다.
 * - 이 글꼴은 기계로 풀 수 있다 (KNOWN_ISSUES — 셸이 있는 CLI가 이미지를 스크립트로 풀면 거짓 verified). 도구 설명은 이미지로 보라고 말한다.
 * - readScreenCheckDigits는 시험·모의 보유자(resources/mock-agent/mock-agent.mjs에 같은 방법)가 '보는' 흉내를 내는 데 쓴다.
 */
import { randomInt } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** 5×7 글꼴 (0–9, 줄마다 왼쪽이 높은 자리) */
export const DIGIT_FONT: readonly (readonly string[])[] = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
];

/** 글꼴 한 칸의 크기 (px) */
export const GLYPH_SCALE = 14;
const GLYPH_W = 5 * GLYPH_SCALE;
const GLYPH_H = 7 * GLYPH_SCALE;
const GAP = 30;
const MARGIN_X = 40;
const MARGIN_Y = 32;
const JITTER = 4;
export const SCREEN_CHECK_WIDTH = MARGIN_X * 2 + GLYPH_W * 4 + GAP * 3;
export const SCREEN_CHECK_HEIGHT = MARGIN_Y * 2 + GLYPH_H;
const BG = 0xc8;
const INK = 0x24;

/** 무작위 네 자리 (0000–9999) */
export function newScreenCheckCode(): string {
  return String(randomInt(0, 10_000)).padStart(4, '0');
}

/** 네 자리 숫자를 그린 PNG. jitter: 숫자마다 [dx, dy] (시험이 고정한다, 기본 ±4px 무작위) */
export function screenCheckImage(code: string, jitter?: readonly (readonly [number, number])[]): Buffer {
  if (!/^\d{4}$/.test(code)) throw new Error('시험 이미지 숫자는 네 자리여야 합니다');
  const w = SCREEN_CHECK_WIDTH;
  const h = SCREEN_CHECK_HEIGHT;
  const px = Buffer.alloc(w * h, BG);
  for (let i = 0; i < 4; i++) {
    const glyph = DIGIT_FONT[Number(code[i])]!;
    const [dx, dy] = jitter?.[i] ?? [randomInt(-JITTER, JITTER + 1), randomInt(-JITTER, JITTER + 1)];
    const ox = MARGIN_X + i * (GLYPH_W + GAP) + clampJitter(dx);
    const oy = MARGIN_Y + clampJitter(dy);
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (glyph[r]![c] !== '1') continue;
        for (let yy = 0; yy < GLYPH_SCALE; yy++) px.fill(INK, (oy + r * GLYPH_SCALE + yy) * w + ox + c * GLYPH_SCALE, (oy + r * GLYPH_SCALE + yy) * w + ox + (c + 1) * GLYPH_SCALE);
      }
    }
  }
  return encodeGreyPng(w, h, px);
}

function clampJitter(v: number): number {
  return Math.max(-JITTER, Math.min(JITTER, Math.round(v)));
}

// ───── PNG ─────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 8비트 회색 PNG (거르기 0) — 메타데이터 덩어리 없이 IHDR·IDAT·IEND만 */
export function encodeGreyPng(w: number, h: number, pixels: Buffer): Buffer {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 0; // 회색
  return Buffer.concat([PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** PNG 덩어리 (서명 확인). 알아볼 수 없으면 null */
export function pngChunks(png: Buffer): { type: string; data: Buffer }[] | null {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  const out: { type: string; data: Buffer }[] = [];
  let at = 8;
  while (at + 8 <= png.length) {
    const len = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    if (at + 12 + len > png.length) return null;
    out.push({ type, data: png.subarray(at + 8, at + 8 + len) });
    at += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

/**
 * 시험 이미지에서 네 자리를 읽는다 (시험·모의 보유자의 '보기' 흉내). 8비트 회색·거르기 0인 우리 PNG만 읽는다. 읽지 못하면 null
 */
export function readScreenCheckDigits(png: Buffer): string | null {
  const chunks = pngChunks(png);
  if (!chunks) return null;
  const ihdr = chunks.find((c) => c.type === 'IHDR')?.data;
  if (!ihdr || ihdr[8] !== 8 || ihdr[9] !== 0) return null;
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  } catch {
    return null;
  }
  if (raw.length < (w + 1) * h) return null;
  const dark = (x: number, y: number): boolean => raw[y * (w + 1) + 1 + x]! < 0x80;
  // 세로로 훑어 어두운 칸이 있는 열을 묶는다 — 숫자 하나가 한 묶음이다
  const runs: [number, number][] = [];
  let start = -1;
  for (let x = 0; x <= w; x++) {
    let any = false;
    if (x < w) for (let y = 0; y < h && !any; y++) any = dark(x, y);
    if (any && start < 0) start = x;
    if (!any && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (runs.length !== 4) return null;
  let out = '';
  for (const [x0, x1] of runs) {
    let y0 = h;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!dark(x, y)) continue;
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    }
    const cell = (y1 - y0 + 1) / 7;
    if (!(cell >= 1)) return null;
    const cols = Math.round((x1 - x0 + 1) / cell);
    const bits: string[] = [];
    for (let r = 0; r < 7; r++) {
      let row = '';
      for (let c = 0; c < cols; c++) row += dark(Math.floor(x0 + (c + 0.5) * cell), Math.floor(y0 + (r + 0.5) * cell)) ? '1' : '0';
      bits.push(row);
    }
    const digit = DIGIT_FONT.findIndex((g) => sameCropped(g, bits));
    if (digit < 0) return null;
    out += String(digit);
  }
  return out;
}

/** 글꼴을 빈 열을 뺀 꼴로 견준다 ('1'은 가운데 세 열) */
function sameCropped(glyph: readonly string[], bits: readonly string[]): boolean {
  let lo = 5;
  let hi = -1;
  for (const row of glyph) {
    for (let c = 0; c < 5; c++) {
      if (row[c] !== '1') continue;
      lo = Math.min(lo, c);
      hi = Math.max(hi, c);
    }
  }
  if (hi - lo + 1 !== bits[0]!.length) return false;
  return glyph.every((row, r) => row.slice(lo, hi + 1) === bits[r]);
}
