import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';

const wrapper = process.env.AI_SUGGESTION_VITEST_WRAPPER;
assert.ok(wrapper && existsSync(wrapper), 'Set AI_SUGGESTION_VITEST_WRAPPER to the approved Vitest wrapper');
const sheet = 'components/AiSuggestion.tsx';
const baseline = 'lib/aiSuggestion.ts';
const fake = 'api/fake/index.ts';
const judge = 'api/fake/aiSuggestion.ts';
const cases = [
  ['entry without options', sheet, '{aiSuggestion && <button', '{true && <button'],
  ['lost current model', sheet, "{currentModel ?? '기본 모델'}", "{'기본 모델'}"],
  ['lost current effort', sheet, '({member.ai.effortValue})', '({member.ai.kind})'],
  ['lost catalog notes', sheet, '<dd>{row.note}</dd>', '<dd>{row.id}</dd>'],
  ['missing decision explanation', sheet, '바꿀지 유지할지 정합니다', '확인합니다'],
  ['replacement warning inverted', sheet, '{fixed && <p', '{!fixed && <p'],
  ['equivalent selection can send', sheet, 'disabled={!choice.differs || sending}', 'disabled={sending}'],
  ['compares tier labels instead of actual values', baseline, 'effort.values[kind] !== baseline.effort', 'effort.tier !== member.ai.effortTier'],
  ['ignores scheduled AI', baseline, 'const next = member.pendingAiChange;', 'const next = null;'],
  ['wrong project', sheet, 'target: projectId, text: reason', "target: 'main', text: reason"],
  ['wrong team member', sheet, 'memberId: member.id', 'memberId: projectId'],
  ['lost reason', sheet, 'text: reason,', "text: '',"],
  ['sends unchosen model', sheet, '...(modelId && { model: modelId })', 'model: modelId'],
  ['sends unchosen effort', sheet, '...(tier && { effortTier: tier })', 'effortTier: tier'],
  ['missing progress', sheet, "{sending ? '보내는 중…' : ''}", "{''}"],
  ['duplicate submission', sheet, 'if (!choice.differs || sending) return;', 'if (!choice.differs) return;'],
  ['hides server refusal', sheet, '? failure.message :', "? '오류' :"],
  ['drops refused model', sheet, 'setSending(false);', "setModelId(''); setSending(false);"],
  ['drops refused effort', sheet, 'setSending(false);', "setTier(''); setSending(false);"],
  ['drops refused reason', sheet, 'setSending(false);', "setReason(''); setSending(false);"],
  ['missing success receipt', sheet, "toast('건의를 보냈습니다'", "toast('접수'"],
  ['opens another conversation', sheet, 'openConversation(projectId);', "openConversation('main');"],
  ['fake omits options', fake, 'aiSuggestion: fakeSuggestionOptions(member, settings.team),', 'aiSuggestion: null,'],
  ['fake accepts same AI', judge, 'if (!differs) throw', 'if (false) throw'],
  ['fake posts in main chat', fake, 'const thread = conversations[input.target] ??= [];', 'const thread = conversations.main ??= [];'],
  ['fake loses owner line', judge, '팀원 AI 변경 건의: ', '작업 요청: '],
  ['fake never replies', fake, '}, 1000);', '}, 60000);'],
  ['fake loses accepted configuration', fake, 'else Object.assign(person, decision);', 'else Object.assign(person, {});'],
  ['fake replaces fixed configuration in place', judge, 'if (options.fixed) return', 'if (false) return'],
  ['fake omits reply notification', fake, "emit('notification', notice);", 'void notice;'],
];

const root = process.cwd();
const temp = mkdtempSync(resolve(tmpdir(), 'ai-suggestion-mutants-'));
const modules = resolve(temp, 'node_modules');
function run() {
  const child = spawnSync('bash', [resolve(wrapper), 'run', '--config', 'src/renderer/tools/vitest.config.ts',
    '--fsModuleCachePath', resolve(temp, 'module-cache'), '--no-cache', 'ai-suggestion.test.ts'],
    { cwd: temp, encoding: 'utf8', windowsHide: true, env: { ...process.env, VT_WORKERS: '1' } });
  if (child.error) throw child.error;
  return { status: child.status, output: child.stdout + child.stderr };
}
try {
  for (const path of ['src/shared', 'src/renderer/src', 'src/renderer/tools/vitest.config.ts', 'tsconfig.web.json', 'tsconfig.node.json', 'tsconfig.json', 'package.json']) {
    cpSync(resolve(root, path), resolve(temp, path), { recursive: true });
  }
  symlinkSync(resolve(root, 'node_modules'), modules, 'junction');
  const clean = run();
  assert.equal(clean.status, 0, clean.output);
  const results = [];
  for (const [name, file, from, to] of cases) {
    const path = resolve(temp, 'src/renderer/src', file);
    const original = readFileSync(path, 'utf8');
    assert.equal(original.split(from).length, 2, 'Mutation anchor: ' + name);
    writeFileSync(path, original.replace(from, to));
    const result = run();
    const caught = result.status === 1 && /AssertionError/.test(result.output);
    console.log(name, caught ? 'caught' : 'MISSED');
    if (!caught) console.log(result.output);
    results.push({ name, caught });
    writeFileSync(path, original);
  }
  assert.ok(results.every(row => row.caught), 'A mutant survived or failed without an assertion');
  const output = resolve(root, 'docs/design/ai-suggestion/mutation-results.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(results, null, 2) + '\n');
  console.log(results.length + '/' + results.length + ' caught');
} finally {
  if (existsSync(modules)) unlinkSync(modules);
  assert.equal(dirname(temp), resolve(tmpdir()));
  rmSync(temp, { recursive: true, force: true });
}
