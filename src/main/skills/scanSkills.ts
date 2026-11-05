/**
 * 스킬 폴더 자동 탐색 (SKL-03). 운영 설정의 스킬 목록·자동/수동 구분의 바탕이 된다.
 *
 * Claude: <claudeDir>/skills/<스킬>/SKILL.md, <프로젝트>/.claude/skills/<스킬>/SKILL.md,
 *         플러그인 스킬(installed_plugins.json의 설치 위치, 없으면 plugins/cache 아래를 깊이 제한으로 탐색) — 이름은 '<플러그인>:<스킬>'
 * Codex:  <codexHome>/skills/**\/SKILL.md(.system 포함), <home>/.agents/skills/<스킬>/SKILL.md,
 *         <프로젝트>/.agents/skills/<스킬>/SKILL.md, <프로젝트>/.codex/skills/<스킬>/SKILL.md
 *
 * 수동 발동 판정: Claude frontmatter 'disable-model-invocation: true', Codex agents/openai.yaml 'policy.allow_implicit_invocation: false'.
 * 같은 종류·같은 이름은 프로젝트 > 사용자 > 플러그인 순으로 하나만 남긴다. 읽지 못한 파일은 건너뛰고 onWarning으로 알린다.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { AiKind, SkillEntry } from '@shared/domain';

export interface ScanSkillsOptions {
  /** 사용자 홈 폴더 */
  home: string;
  /** 등록된 프로젝트 폴더들 (앞쪽이 우선) */
  projectPaths: string[];
  /** 재귀 탐색 깊이 (Codex 사용자 스킬 폴더, Claude 플러그인 캐시). 기본 6 */
  maxDepth?: number;
  /** Claude 설정 폴더 (CLAUDE_CONFIG_DIR). 기본 <home>/.claude */
  claudeDir?: string;
  /** Codex 설정 폴더 (CODEX_HOME). 기본 <home>/.codex */
  codexHome?: string;
  /** 읽지 못한 파일·폴더 알림 (없는 폴더는 알리지 않는다). 기본 console.warn */
  onWarning?: (message: string, filePath: string, error: unknown) => void;
}

const DEFAULT_MAX_DEPTH = 6;
const SKILL_FILE = 'SKILL.md';
const MAX_READ_BYTES = 64 * 1024;
const MAX_NAME = 120;
const MAX_DESCRIPTION = 1024;
const SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__']);
const MISSING_CODES = new Set(['ENOENT', 'ENOTDIR']);

/** 우선순위: 낮을수록 먼저 */
const Rank = { Project: 0, User: 1, Plugin: 2 } as const;
type Rank = (typeof Rank)[keyof typeof Rank];

interface Candidate extends SkillEntry {
  rank: Rank;
  order: number;
}

// ───────────────────────── 작은 YAML 해석기 ─────────────────────────
// frontmatter·openai.yaml에서 필요한 만큼만: 중첩 맵, 목록, 따옴표('·")·여러 줄 일반 값, 블록 값(|·>, +·- 끝 처리).
// 앵커·별칭·태그·흐름 표기({}, [])는 해석하지 않고 원문 문자열로 둔다 (실행되는 것이 없어 안전하다).

export type YamlValue = string | YamlValue[] | { [key: string]: YamlValue };
type YamlMap = { [key: string]: YamlValue };

const indentOf = (line: string): number => line.length - line.replace(/^[ \t]+/, '').length;
const isSkippable = (line: string): boolean => {
  const t = line.trim();
  return t.length === 0 || t.startsWith('#');
};

function unescapeDoubleQuoted(s: string): string {
  return s.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8})|(.))/g, (_m, x, u, U, c: string | undefined) => {
    const hex = x ?? u ?? U;
    if (hex) {
      const cp = parseInt(hex, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    switch (c) {
      case 'n':
        return '\n';
      case 't':
        return '\t';
      case 'r':
        return '\r';
      case '0':
        return '\0';
      case ' ':
        return ' ';
      default:
        return c ?? '';
    }
  });
}

/** 따옴표 값의 줄바꿈 접기: 한 줄바꿈은 공백, 빈 줄은 줄바꿈 */
function foldQuotedLines(lines: string[]): string {
  let out = '';
  let pendingBreaks = 0;
  lines.forEach((raw, idx) => {
    const line = idx === 0 ? raw.replace(/[ \t]+$/, '') : idx === lines.length - 1 ? raw.replace(/^[ \t]+/, '') : raw.trim();
    if (idx > 0 && line.length === 0 && idx < lines.length - 1) {
      pendingBreaks++;
      return;
    }
    if (idx > 0) out += pendingBreaks > 0 ? '\n'.repeat(pendingBreaks) : ' ';
    pendingBreaks = 0;
    out += line;
  });
  return out;
}

function stripInlineComment(s: string): string {
  const i = s.search(/\s#/);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

/** 따옴표 값을 닫는 따옴표까지 읽는다 (여러 줄 가능). 끝나는 줄 다음 위치를 돌려준다 */
function readQuoted(lines: string[], i: number, first: string): [string, number] {
  const quote = first[0]!;
  const parts: string[] = [];
  let text = first.slice(1);
  let idx = i;
  for (;;) {
    let end = -1;
    if (quote === '"') {
      for (let k = 0; k < text.length; k++) {
        if (text[k] === '\\') k++;
        else if (text[k] === '"') {
          end = k;
          break;
        }
      }
    } else {
      for (let k = 0; k < text.length; k++) {
        if (text[k] === "'") {
          if (text[k + 1] === "'") k++;
          else {
            end = k;
            break;
          }
        }
      }
    }
    if (end !== -1) {
      parts.push(text.slice(0, end));
      break;
    }
    parts.push(text);
    if (idx >= lines.length) break;
    text = lines[idx]!;
    idx++;
  }
  const folded = foldQuotedLines(parts);
  return [quote === '"' ? unescapeDoubleQuoted(folded) : folded.replace(/''/g, "'"), idx];
}

function readBlockScalar(lines: string[], i: number, parentIndent: number, header: string): [string, number] {
  const h = /^([|>])([+-]?)([1-9]?)([+-]?)/.exec(header)!;
  const folded = h[1] === '>';
  const chomp = h[2] || h[4];
  let blockIndent = h[3] ? parentIndent + Number(h[3]) : -1;
  const body: string[] = [];
  let idx = i;
  for (; idx < lines.length; idx++) {
    const line = lines[idx]!;
    if (line.trim().length === 0) {
      body.push('');
      continue;
    }
    const ind = indentOf(line);
    if (ind <= parentIndent) break;
    if (blockIndent === -1) blockIndent = ind;
    if (ind < blockIndent) break;
    body.push(line.slice(blockIndent));
  }
  // 블록 뒤의 빈 줄은 다음 키와의 사이이므로 끝 처리 규칙에 따른다
  let trailing = 0;
  while (body.length > 0 && body[body.length - 1] === '') {
    body.pop();
    trailing++;
  }
  let text: string;
  if (!folded) {
    text = body.join('\n');
  } else {
    text = '';
    let prevMoreIndented = false;
    body.forEach((line, k) => {
      const moreIndented = /^[ \t]/.test(line);
      if (k === 0) text = line;
      else if (line === '') text += '\n';
      else if (body[k - 1] === '' || moreIndented || prevMoreIndented) text += (text.endsWith('\n') ? '' : '\n') + line;
      else text += ` ${line}`;
      prevMoreIndented = moreIndented;
    });
  }
  if (chomp === '+') text += '\n'.repeat(trailing + (body.length > 0 ? 1 : 0));
  else if (chomp !== '-' && body.length > 0) text += '\n';
  return [text, idx];
}

function parsePlainMultiline(lines: string[], i: number, parentIndent: number, first: string): [string, number] {
  const parts = [stripInlineComment(first)];
  let idx = i;
  while (idx < lines.length) {
    const line = lines[idx]!;
    if (line.trim().length === 0) {
      // 빈 줄 뒤에 더 들여쓴 줄이 이어지면 같은 값의 문단 나눔
      let k = idx;
      while (k < lines.length && lines[k]!.trim().length === 0) k++;
      if (k < lines.length && indentOf(lines[k]!) > parentIndent && !lines[k]!.trim().startsWith('#')) {
        parts.push('\n'.repeat(k - idx));
        idx = k;
        continue;
      }
      break;
    }
    if (indentOf(line) <= parentIndent || line.trim().startsWith('#')) break;
    parts.push(stripInlineComment(line));
    idx++;
  }
  // 줄바꿈 하나는 공백으로 접고, 빈 줄 n개는 줄바꿈 n개로 남긴다
  let out = '';
  for (const p of parts) out = out.length === 0 || p.startsWith('\n') || out.endsWith('\n') ? out + p : `${out} ${p}`;
  return [out, idx];
}

function parseValue(lines: string[], i: number, parentIndent: number, rest: string): [YamlValue, number] {
  const r = rest.trim();
  if (r.startsWith('|') || r.startsWith('>')) return readBlockScalar(lines, i, parentIndent, r);
  if (r.startsWith('"') || r.startsWith("'")) return readQuoted(lines, i, r);
  if (r.length === 0 || r.startsWith('#')) {
    let k = i;
    while (k < lines.length && isSkippable(lines[k]!)) k++;
    if (k >= lines.length) return ['', k];
    const ind = indentOf(lines[k]!);
    const isList = lines[k]!.trim().startsWith('- ') || lines[k]!.trim() === '-';
    // 목록은 같은 들여쓰기에 와도 된다 (key:\n- a)
    if (isList && ind >= parentIndent) return parseList(lines, k, ind);
    if (ind > parentIndent) return parseMap(lines, k, ind);
    return ['', i];
  }
  if (r.startsWith('[') || r.startsWith('{') || r.startsWith('&') || r.startsWith('*') || r.startsWith('!')) return [stripInlineComment(r), i];
  return parsePlainMultiline(lines, i, parentIndent, r);
}

function parseList(lines: string[], start: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isSkippable(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    const t = line.trim();
    if (ind < indent || (ind === indent && !(t.startsWith('- ') || t === '-'))) break;
    if (ind > indent) {
      i++;
      continue;
    }
    const item = t === '-' ? '' : t.slice(2);
    const [v, next] = parseValue(lines, i + 1, indent, item);
    out.push(v);
    i = next;
  }
  return [out, i];
}

const KEY_LINE_RE = /^[ \t]*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"\-[{][^:]*?|-[^\s:][^:]*?))[ \t]*:(?:[ \t]+(.*)|[ \t]*)$/;

function parseMap(lines: string[], start: number, indent: number): [YamlMap, number] {
  const map: YamlMap = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isSkippable(line)) {
      i++;
      continue;
    }
    const ind = indentOf(line);
    if (ind < indent) break;
    if (ind > indent) {
      // 예상보다 깊은 줄(앞 값의 남은 부분)은 건너뛴다
      i++;
      continue;
    }
    const m = KEY_LINE_RE.exec(line);
    if (!m) {
      i++;
      continue;
    }
    const key = m[1] !== undefined ? unescapeDoubleQuoted(m[1]) : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]!.trim();
    const [value, next] = parseValue(lines, i + 1, indent, m[4] ?? '');
    if (!(key in map)) map[key] = value;
    i = Math.max(next, i + 1);
  }
  return [map, i];
}

/** 위의 제한된 YAML을 해석한다. 해석할 수 없는 줄은 건너뛰고, 던지지 않는다 */
export function parseYamlSubset(src: string): YamlMap {
  const lines = src.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  let k = 0;
  while (k < lines.length && isSkippable(lines[k]!)) k++;
  if (k >= lines.length) return {};
  return parseMap(lines, k, indentOf(lines[k]!))[0];
}

/** SKILL.md 앞의 '---' 블록과 본문을 나눈다 */
export function splitFrontmatter(text: string): { meta: string; body: string } {
  const src = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const m = /^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
  if (!m) {
    const empty = /^---[ \t]*\n(?:---|\.\.\.)[ \t]*(?:\n|$)/.exec(src);
    return empty ? { meta: '', body: src.slice(empty[0].length) } : { meta: '', body: src };
  }
  return { meta: m[1]!, body: src.slice(m[0].length) };
}

const asString = (v: YamlValue | undefined): string | null => (typeof v === 'string' ? v : null);
const asMap = (v: YamlValue | undefined): YamlMap | null => (v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : null);
const isTrue = (v: YamlValue | undefined): boolean => typeof v === 'string' && /^(?:true|yes|on)$/i.test(v.trim());
const isFalse = (v: YamlValue | undefined): boolean => typeof v === 'string' && /^(?:false|no|off)$/i.test(v.trim());

function cleanName(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanDescription(s: string): string {
  const t = s
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(t).slice(0, MAX_DESCRIPTION).join('');
}

/** frontmatter에 설명이 없을 때 본문 첫 문단 (제목·코드 블록 제외) */
function firstParagraph(body: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (out.length > 0) break;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) {
      if (out.length > 0) break;
      continue;
    }
    if (/^(#|<!--|>|\||---|\*\*\*)/.test(line)) {
      if (out.length > 0) break;
      continue;
    }
    out.push(line);
  }
  return Array.from(out.join(' ')).slice(0, 200).join('');
}

// ───────────────────────── 파일 탐색 ─────────────────────────

const errCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : undefined;

class Scanner {
  private order = 0;
  readonly found: Candidate[] = [];
  private readonly visitedDirs = new Set<string>();

  constructor(
    private readonly maxDepth: number,
    readonly warn: (message: string, filePath: string, error: unknown) => void,
  ) {}

  async readJson(file: string): Promise<unknown | null> {
    const text = await this.readText(file, 4 * 1024 * 1024);
    if (text === null) return null;
    try {
      return JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch (err) {
      this.warn('JSON 형식이 아니라 건너뜁니다', file, err);
      return null;
    }
  }

  /** 없는 폴더·파일은 조용히, 다른 오류는 알리고 null */
  private async attempt<T>(what: string, p: string, op: () => Promise<T>): Promise<T | null> {
    try {
      return await op();
    } catch (err) {
      if (!MISSING_CODES.has(errCode(err) ?? '')) this.warn(`${what}을(를) 읽지 못했습니다`, p, err);
      return null;
    }
  }

  async readText(file: string, limit = MAX_READ_BYTES): Promise<string | null> {
    return this.attempt('파일', file, async () => {
      const fh = await fsp.open(file, 'r');
      try {
        const buf = Buffer.alloc(limit);
        const { bytesRead } = await fh.read(buf, 0, limit, 0);
        return buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await fh.close();
      }
    });
  }

  /** 폴더 안의 하위 폴더 (폴더 연결은 따라가되 실제 경로로 한 번만) */
  async subdirs(dir: string): Promise<string[]> {
    const entries = await this.attempt('폴더', dir, () => fsp.readdir(dir, { withFileTypes: true }));
    if (!entries) return [];
    const out: string[] = [];
    for (const e of entries) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(full);
      else if (e.isSymbolicLink()) {
        const st = await this.attempt('연결된 폴더', full, () => fsp.stat(full));
        if (st?.isDirectory()) out.push(full);
      }
    }
    return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }

  private async firstVisit(dir: string): Promise<boolean> {
    const real = (await this.attempt('폴더', dir, () => fsp.realpath(dir))) ?? path.resolve(dir);
    const key = process.platform === 'win32' || process.platform === 'darwin' ? real.toLowerCase() : real;
    if (this.visitedDirs.has(key)) return false;
    this.visitedDirs.add(key);
    return true;
  }

  async isFile(p: string): Promise<boolean> {
    const st = await this.attempt('파일', p, () => fsp.stat(p));
    return st?.isFile() ?? false;
  }

  async readSkill(skillDir: string, source: AiKind, rank: Rank, prefix: string | null): Promise<void> {
    const file = path.join(skillDir, SKILL_FILE);
    const text = await this.readText(file);
    if (text === null) return;
    const { meta, body } = splitFrontmatter(text);
    const fm = parseYamlSubset(meta);
    const baseName = cleanName(asString(fm.name) ?? '') || cleanName(path.basename(skillDir));
    if (baseName.length === 0) return;
    let description = asString(fm.description) ?? asString(asMap(fm.metadata)?.['short-description']) ?? '';
    let manual = source === 'claude' && isTrue(fm['disable-model-invocation']);
    if (source === 'codex') {
      const yamlFile = path.join(skillDir, 'agents', 'openai.yaml');
      const yamlText = (await this.isFile(yamlFile)) ? await this.readText(yamlFile) : null;
      if (yamlText !== null) {
        const doc = parseYamlSubset(yamlText);
        if (isFalse(asMap(doc.policy)?.allow_implicit_invocation)) manual = true;
        if (description.trim().length === 0) description = asString(asMap(doc.interface)?.short_description) ?? '';
      }
    }
    if (description.trim().length === 0) description = firstParagraph(body);
    this.found.push({
      name: prefix ? `${prefix}:${baseName}` : baseName,
      description: cleanDescription(description),
      source,
      path: file,
      mode: manual ? 'manual' : 'auto',
      rank,
      order: this.order++,
    });
  }

  /** <root>/<스킬>/SKILL.md (한 단계) */
  async scanFlat(root: string, source: AiKind, rank: Rank, prefix: string | null = null): Promise<void> {
    if (!(await this.firstVisit(root))) return;
    for (const dir of await this.subdirs(root)) {
      if (await this.isFile(path.join(dir, SKILL_FILE))) await this.readSkill(dir, source, rank, prefix);
    }
  }

  /** <root>/**\/SKILL.md — SKILL.md가 있는 폴더에서 멈추고, 깊이 제한까지만 */
  async scanDeep(root: string, source: AiKind, rank: Rank): Promise<void> {
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth || !(await this.firstVisit(dir))) return;
      if (depth > 0 && (await this.isFile(path.join(dir, SKILL_FILE)))) {
        await this.readSkill(dir, source, rank, null);
        return;
      }
      for (const sub of await this.subdirs(dir)) await walk(sub, depth + 1);
    };
    await walk(root, 0);
  }

  /** 설치 목록이 없을 때: plugins/cache 아래 'skills' 폴더를 깊이 제한으로 찾는다 */
  async findSkillsDirs(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > this.maxDepth || !(await this.firstVisit(dir))) return;
      for (const sub of await this.subdirs(dir)) {
        if (path.basename(sub) === 'skills') out.push(sub);
        else await walk(sub, depth + 1);
      }
    };
    await walk(root, 0);
    return out;
  }
}

// ───────────────────────── Claude 플러그인 ─────────────────────────

interface PluginInstall {
  /** 'name@marketplace' */
  id: string;
  installPath: string;
}

/** installed_plugins.json (version 1: 객체, version 2: 배열) */
function parseInstalledPlugins(json: unknown): PluginInstall[] | null {
  if (typeof json !== 'object' || json === null || !('plugins' in json)) return null;
  const plugins = (json as { plugins: unknown }).plugins;
  if (typeof plugins !== 'object' || plugins === null) return null;
  const out: PluginInstall[] = [];
  for (const [id, raw] of Object.entries(plugins as Record<string, unknown>)) {
    for (const rec of Array.isArray(raw) ? raw : [raw]) {
      if (typeof rec === 'object' && rec !== null && typeof (rec as { installPath?: unknown }).installPath === 'string') {
        out.push({ id, installPath: (rec as { installPath: string }).installPath });
      }
    }
  }
  return out;
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pb = b.split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === y) continue;
    if (x === undefined) return 1;
    if (y === undefined) return -1;
    if (typeof x === 'number' && typeof y === 'number') return y - x;
    return String(y).localeCompare(String(x));
  }
  return 0;
}

async function pluginName(scanner: Scanner, pluginRoot: string, fallback: string): Promise<string> {
  const manifest = path.join(pluginRoot, '.claude-plugin', 'plugin.json');
  if (!(await scanner.isFile(manifest))) return fallback;
  const json = await scanner.readJson(manifest);
  const name = typeof json === 'object' && json !== null ? (json as { name?: unknown }).name : undefined;
  return typeof name === 'string' && name.trim().length > 0 ? cleanName(name) : fallback;
}

async function scanClaudePlugins(scanner: Scanner, claudeDir: string): Promise<void> {
  const pluginsDir = path.join(claudeDir, 'plugins');
  const settings = await scanner.readJson(path.join(claudeDir, 'settings.json'));
  const enabled =
    typeof settings === 'object' && settings !== null && typeof (settings as { enabledPlugins?: unknown }).enabledPlugins === 'object'
      ? ((settings as { enabledPlugins: Record<string, unknown> }).enabledPlugins ?? {})
      : {};
  const installedFile = path.join(pluginsDir, 'installed_plugins.json');
  const installs = (await scanner.isFile(installedFile)) ? parseInstalledPlugins(await scanner.readJson(installedFile)) : null;

  if (installs) {
    const seen = new Set<string>();
    for (const inst of installs) {
      // 대표가 끈 플러그인의 스킬은 목록에 넣지 않는다
      if (enabled[inst.id] === false) continue;
      const root = path.resolve(inst.installPath);
      if (seen.has(root.toLowerCase())) continue;
      seen.add(root.toLowerCase());
      const name = await pluginName(scanner, root, inst.id.split('@')[0] || path.basename(path.dirname(root)));
      await scanner.scanFlat(path.join(root, 'skills'), 'claude', Rank.Plugin, name);
    }
    return;
  }
  // 설치 목록이 없으면 캐시를 뒤진다: cache/<마켓>/<플러그인>/<버전>/skills — 버전이 여럿이면 최신을 먼저
  const skillsDirs = await scanner.findSkillsDirs(path.join(pluginsDir, 'cache'));
  const byPlugin = new Map<string, string[]>();
  for (const dir of skillsDirs) {
    const root = path.dirname(dir);
    const key = path.dirname(root);
    byPlugin.set(key, [...(byPlugin.get(key) ?? []), root]);
  }
  for (const [pluginDir, roots] of byPlugin) {
    roots.sort((a, b) => compareVersionsDesc(path.basename(a), path.basename(b)));
    for (const root of roots) {
      const name = await pluginName(scanner, root, path.basename(pluginDir));
      await scanner.scanFlat(path.join(root, 'skills'), 'claude', Rank.Plugin, name);
    }
  }
}

// ───────────────────────── 진입점 ─────────────────────────

export async function scanSkills(opts: ScanSkillsOptions): Promise<SkillEntry[]> {
  const home = path.resolve(opts.home);
  const claudeDir = path.resolve(opts.claudeDir ?? path.join(home, '.claude'));
  const codexHome = path.resolve(opts.codexHome ?? path.join(home, '.codex'));
  const maxDepth = Number.isInteger(opts.maxDepth) && (opts.maxDepth as number) >= 1 ? (opts.maxDepth as number) : DEFAULT_MAX_DEPTH;
  const warn = opts.onWarning ?? ((message: string, filePath: string, error: unknown) => console.warn(`[스킬] ${message}: ${filePath}`, error));
  const scanner = new Scanner(maxDepth, warn);

  for (const project of opts.projectPaths ?? []) {
    if (typeof project !== 'string' || project.trim().length === 0) continue;
    const root = path.resolve(project);
    await scanner.scanFlat(path.join(root, '.claude', 'skills'), 'claude', Rank.Project);
    await scanner.scanFlat(path.join(root, '.agents', 'skills'), 'codex', Rank.Project);
    await scanner.scanFlat(path.join(root, '.codex', 'skills'), 'codex', Rank.Project);
  }
  await scanner.scanFlat(path.join(claudeDir, 'skills'), 'claude', Rank.User);
  await scanner.scanFlat(path.join(home, '.agents', 'skills'), 'codex', Rank.User);
  await scanner.scanDeep(path.join(codexHome, 'skills'), 'codex', Rank.User);
  await scanClaudePlugins(scanner, claudeDir);

  // 같은 종류·이름은 우선순위(프로젝트 > 사용자 > 플러그인), 같으면 먼저 찾은 것
  const best = new Map<string, Candidate>();
  for (const c of scanner.found) {
    const key = `${c.source}\u0000${c.name.toLowerCase()}`;
    const cur = best.get(key);
    if (!cur || c.rank < cur.rank || (c.rank === cur.rank && c.order < cur.order)) best.set(key, c);
  }
  return [...best.values()]
    .sort((a, b) => (a.source !== b.source ? (a.source < b.source ? -1 : 1) : a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || (a.path < b.path ? -1 : 1)))
    .map(({ name, description, source, path: p, mode }) => ({ name, description, source, path: p, mode }));
}
