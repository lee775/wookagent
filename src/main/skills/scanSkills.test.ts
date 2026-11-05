import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SkillEntry } from '@shared/domain';
import { parseYamlSubset, scanSkills, splitFrontmatter } from './scanSkills';

let root: string;
let home: string;
let project: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'wook-test-스킬 탐색 '));
  home = path.join(root, '사용자 홈');
  project = path.join(root, '내 프로젝트');
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

const skill = (name: string | null, description: string | null, extra = ''): string =>
  ['---', name !== null ? `name: ${name}` : '', description !== null ? `description: ${description}` : '', extra, '---', '', '# 제목', '', '본문 첫 문단입니다.', '']
    .filter((l, i) => l !== '' || i > 3)
    .join('\n');

const pick = (list: SkillEntry[], source: string, name: string): SkillEntry | undefined => list.find((s) => s.source === source && s.name === name);

describe('splitFrontmatter / parseYamlSubset', () => {
  it('따옴표·여러 줄·블록 값·중첩 맵·목록·주석을 해석한다', () => {
    const yaml = [
      '# 주석',
      'name: "my-skill"',
      "title: 'it''s ok'",
      'escaped: "탭\\t줄\\n끝 \\u00e9 \\"q\\""',
      'plain: 한 줄 값 # 주석은 빠진다',
      'url: https://example.com/a#frag',
      'multi: 첫째 줄',
      '  둘째 줄',
      '',
      '  새 문단',
      'folded: >',
      '  접힌',
      '  문장',
      '',
      '  다음 문단',
      'literal: |-',
      '  줄1',
      '    들여쓴 줄2',
      'keep: |+',
      '  끝 줄바꿈 유지',
      '',
      'quotedMulti: "가',
      '  나',
      '',
      '  다"',
      'metadata:',
      '  short-description: 짧은 설명',
      '  nested:',
      '    deep: 값',
      'allowed-tools:',
      '  - Bash',
      '  - "Read"',
      'flow: [a, b]',
      'empty:',
      'last: 끝',
    ].join('\n');
    const doc = parseYamlSubset(yaml);
    expect(doc).toEqual({
      name: 'my-skill',
      title: "it's ok",
      escaped: '탭\t줄\n끝 é "q"',
      plain: '한 줄 값',
      url: 'https://example.com/a#frag',
      multi: '첫째 줄 둘째 줄\n새 문단',
      folded: '접힌 문장\n다음 문단\n',
      literal: '줄1\n  들여쓴 줄2',
      keep: '끝 줄바꿈 유지\n\n',
      quotedMulti: '가 나\n다',
      metadata: { 'short-description': '짧은 설명', nested: { deep: '값' } },
      'allowed-tools': ['Bash', 'Read'],
      flow: '[a, b]',
      empty: '',
      last: '끝',
    });
  });

  it('BOM·CRLF frontmatter를 나누고, 없으면 본문만', () => {
    expect(splitFrontmatter('\uFEFF---\r\nname: a\r\n---\r\n본문')).toEqual({ meta: 'name: a', body: '본문' });
    expect(splitFrontmatter('# 그냥 문서')).toEqual({ meta: '', body: '# 그냥 문서' });
    expect(splitFrontmatter('---\n---\n본문')).toEqual({ meta: '', body: '본문' });
    expect(parseYamlSubset('::: 이상한 줄\n- 목록만\nname: ok')).toEqual({ name: 'ok' });
  });
});

describe('scanSkills', () => {
  it('Claude 사용자 스킬: 이름·설명·폴더 이름 대체·본문 설명·수동 발동', async () => {
    const dir = path.join(home, '.claude', 'skills');
    await put(path.join(dir, 'doc-writer', 'SKILL.md'), skill('doc-writer', '문서를 정리합니다.'));
    await put(path.join(dir, '이름 없는 스킬', 'SKILL.md'), skill(null, '이름은 폴더에서'));
    await put(path.join(dir, 'no-desc', 'SKILL.md'), skill('no-desc', null));
    await put(path.join(dir, 'manual-one', 'SKILL.md'), skill('manual-one', '수동 전용', 'disable-model-invocation: true'));
    await put(
      path.join(dir, 'folded', 'SKILL.md'),
      '\uFEFF---\r\nname: folded\r\ndescription: >\r\n  여러 줄에 걸친\r\n  설명입니다\r\n---\r\n본문\r\n',
    );
    await put(path.join(dir, 'quoted', 'SKILL.md'), '---\nname: "quoted"\ndescription: "따옴표 \\"설명\\": 콜론 포함"\n---\n');
    await mkdir(path.join(dir, 'no-skill-file'), { recursive: true });
    await put(path.join(dir, 'README.md'), '폴더가 아닌 파일');

    const list = await scanSkills({ home, projectPaths: [] });
    expect(list).toEqual([
      { name: 'doc-writer', description: '문서를 정리합니다.', source: 'claude', path: path.join(dir, 'doc-writer', 'SKILL.md'), mode: 'auto' },
      { name: 'folded', description: '여러 줄에 걸친 설명입니다', source: 'claude', path: path.join(dir, 'folded', 'SKILL.md'), mode: 'auto' },
      { name: 'manual-one', description: '수동 전용', source: 'claude', path: path.join(dir, 'manual-one', 'SKILL.md'), mode: 'manual' },
      { name: 'no-desc', description: '본문 첫 문단입니다.', source: 'claude', path: path.join(dir, 'no-desc', 'SKILL.md'), mode: 'auto' },
      { name: 'quoted', description: '따옴표 "설명": 콜론 포함', source: 'claude', path: path.join(dir, 'quoted', 'SKILL.md'), mode: 'auto' },
      { name: '이름 없는 스킬', description: '이름은 폴더에서', source: 'claude', path: path.join(dir, '이름 없는 스킬', 'SKILL.md'), mode: 'auto' },
    ]);
  });

  it('같은 종류·이름이면 프로젝트 스킬이 사용자 스킬보다 우선하고, 앞 프로젝트가 우선한다', async () => {
    const other = path.join(root, '다른 프로젝트');
    await put(path.join(home, '.claude', 'skills', 'shared', 'SKILL.md'), skill('shared', '사용자'));
    await put(path.join(project, '.claude', 'skills', 'shared', 'SKILL.md'), skill('shared', '프로젝트'));
    await put(path.join(other, '.claude', 'skills', 'shared', 'SKILL.md'), skill('shared', '다른 프로젝트'));
    await put(path.join(home, '.agents', 'skills', 'shared', 'SKILL.md'), skill('shared', 'Codex 사용자'));
    const list = await scanSkills({ home, projectPaths: [project, other] });
    expect(list.map((s) => [s.source, s.name, s.description])).toEqual([
      ['claude', 'shared', '프로젝트'],
      ['codex', 'shared', 'Codex 사용자'],
    ]);
    expect(pick(list, 'claude', 'shared')!.path).toBe(path.join(project, '.claude', 'skills', 'shared', 'SKILL.md'));
  });

  it('Codex: ~/.codex/skills 재귀(.system 포함, 깊이 제한), ~/.agents/skills, 프로젝트 폴더, openai.yaml 수동 정책', async () => {
    const codexSkills = path.join(home, '.codex', 'skills');
    await put(path.join(codexSkills, '.system', 'imagegen', 'SKILL.md'), skill('imagegen', '이미지'));
    await put(
      path.join(codexSkills, '.system', 'review-agent', 'SKILL.md'),
      skill('review-agent', '검토', 'metadata:\n  short-description: 짧게'),
    );
    await put(path.join(codexSkills, '.system', 'review-agent', 'agents', 'openai.yaml'), 'interface:\n  display_name: "Review"\npolicy:\n  allow_implicit_invocation: false\n');
    await put(path.join(codexSkills, 'category', 'nested', 'SKILL.md'), skill('nested', '두 단계 아래'));
    await put(path.join(codexSkills, 'a', 'b', 'c', 'too-deep', 'SKILL.md'), skill('too-deep', '깊이 제한 밖'));
    await put(path.join(codexSkills, 'meta-only', 'SKILL.md'), skill('meta-only', null, 'metadata:\n  short-description: 메타 설명'));
    await put(path.join(home, '.agents', 'skills', 'agents-user', 'SKILL.md'), skill('agents-user', '사용자 agents'));
    await put(path.join(project, '.agents', 'skills', 'proj-agents', 'SKILL.md'), skill('proj-agents', '프로젝트 agents'));
    await put(path.join(project, '.codex', 'skills', 'proj-codex', 'SKILL.md'), skill('proj-codex', '프로젝트 codex'));

    const list = await scanSkills({ home, projectPaths: [project], maxDepth: 3 });
    const codex = list.filter((s) => s.source === 'codex');
    expect(codex.map((s) => s.name)).toEqual(['agents-user', 'imagegen', 'meta-only', 'nested', 'proj-agents', 'proj-codex', 'review-agent']);
    expect(pick(list, 'codex', 'review-agent')!.mode).toBe('manual');
    expect(pick(list, 'codex', 'imagegen')!.mode).toBe('auto');
    expect(pick(list, 'codex', 'meta-only')!.description).toBe('메타 설명');
    expect(list.every((s) => s.source !== 'claude')).toBe(true);

    const deeper = await scanSkills({ home, projectPaths: [], maxDepth: 6 });
    expect(pick(deeper, 'codex', 'too-deep')).toBeDefined();
  });

  it('Claude 플러그인: 설치 목록의 위치에서 "<플러그인>:<스킬>" 이름으로, 끈 플러그인은 제외', async () => {
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    const memRoot = path.join(cache, 'thedotmack', 'claude-mem', '13.24.1');
    const offRoot = path.join(cache, 'mk', 'off-plugin', '1.0.0');
    const projRoot = path.join(cache, 'openai-codex', 'codex', '1.0.2');
    await put(path.join(memRoot, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'claude-mem', version: '13.24.1' }));
    await put(path.join(memRoot, 'skills', 'make-plan', 'SKILL.md'), skill('make-plan', '계획을 세웁니다'));
    await put(path.join(offRoot, 'skills', 'off-skill', 'SKILL.md'), skill('off-skill', '꺼짐'));
    await put(path.join(projRoot, 'skills', 'codex-cli-runtime', 'SKILL.md'), skill('codex-cli-runtime', '런타임', 'user-invocable: false'));
    await put(
      path.join(home, '.claude', 'plugins', 'installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'claude-mem@thedotmack': [{ scope: 'user', installPath: memRoot, version: '13.24.1' }],
          'off-plugin@mk': [{ scope: 'user', installPath: offRoot, version: '1.0.0' }],
          'codex@openai-codex': [
            { scope: 'project', installPath: projRoot, version: '1.0.2' },
            { scope: 'user', installPath: projRoot, version: '1.0.2' },
          ],
        },
      }),
    );
    await put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'off-plugin@mk': false, 'claude-mem@thedotmack': true } }));

    const list = await scanSkills({ home, projectPaths: [] });
    expect(list.map((s) => s.name)).toEqual(['claude-mem:make-plan', 'codex:codex-cli-runtime']);
    expect(list[0]!.path).toBe(path.join(memRoot, 'skills', 'make-plan', 'SKILL.md'));
  });

  it('설치 목록이 없으면 캐시를 깊이 제한으로 뒤지고, 버전이 여럿이면 최신을 남긴다', async () => {
    const cache = path.join(home, '.claude', 'plugins', 'cache', 'mk', 'tool');
    await put(path.join(cache, '1.2.0', 'skills', 'helper', 'SKILL.md'), skill('helper', '옛 버전'));
    await put(path.join(cache, '1.10.0', 'skills', 'helper', 'SKILL.md'), skill('helper', '새 버전'));
    const list = await scanSkills({ home, projectPaths: [] });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'tool:helper', description: '새 버전', source: 'claude' });
  });

  it('읽지 못하는 파일·깨진 JSON·폴더 고리에도 던지지 않고 경고만 남긴다', async () => {
    const warnings: string[] = [];
    const dir = path.join(home, '.claude', 'skills');
    await put(path.join(dir, 'ok', 'SKILL.md'), skill('ok', '정상'));
    // SKILL.md가 파일이 아니라 폴더
    await mkdir(path.join(dir, 'weird', 'SKILL.md'), { recursive: true });
    await put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), '{ 깨진 json');
    // 폴더 고리: skills/loop/back → skills
    const codexSkills = path.join(home, '.codex', 'skills');
    await mkdir(path.join(codexSkills, 'loop'), { recursive: true });
    await symlink(codexSkills, path.join(codexSkills, 'loop', 'back'), process.platform === 'win32' ? 'junction' : 'dir');
    await put(path.join(codexSkills, 'real', 'SKILL.md'), skill('real', '진짜'));

    const list = await scanSkills({ home, projectPaths: [path.join(root, '없는 프로젝트'), ''], onWarning: (m, p) => warnings.push(`${m} ${p}`) });
    expect(list.map((s) => `${s.source}:${s.name}`)).toEqual(['claude:ok', 'codex:real']);
    expect(warnings.some((w) => w.includes('installed_plugins.json'))).toBe(true);
  });

  it('스킬 폴더가 하나도 없으면 빈 목록', async () => {
    await expect(scanSkills({ home, projectPaths: [project] })).resolves.toEqual([]);
  });
});
