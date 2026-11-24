import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { MemberDetail } from '../../../shared/views';
import { members, roles, settings } from '../api/fake/data';
import { fakeSuggestionOptions } from '../api/fake/aiSuggestion';
import { AiSuggestion, SuggestionLetter } from './AiSuggestion';

const host = vi.hoisted(() => ({ state: [] as unknown[], index: 0, invoke: vi.fn(), toast: vi.fn(), open: vi.fn() }));
vi.mock('../api/bridge', () => ({ getBridge: () => ({ invoke: host.invoke }) }));
vi.mock('../api/store', () => ({ toast: host.toast }));
vi.mock('../lib/commands', () => ({ openConversation: host.open }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: () => {}, useRef: (current: unknown) => ({ current }),
  useState: (initial: unknown) => {
    const slot = host.index++;
    if (!(slot in host.state)) host.state[slot] = initial;
    return [host.state[slot], (value: unknown) => { host.state[slot] = value; }];
  },
}));

const member = { ...members[3], ai: { ...members[3].ai, model: 'sonnet', modelValue: 'sonnet' } };
const options = fakeSuggestionOptions(member, settings.team)!;
const props = { member, projectId: member.projectId!, options, fixed: true, sent: vi.fn(), dismiss: vi.fn() };
const detail: MemberDetail = { member, role: roles[0], sessions: [], recentTurns: [], currentTask: null, queuedTasks: [], history: [], messages: [] };
type Props = {
  children?: ReactNode; value?: string; type?: string; id?: string; checked?: boolean; disabled?: boolean;
  onChange?: (event: { target: { value: string } }) => void; onSubmit?: (event: { preventDefault: () => void }) => Promise<void>;
};
function controls(node: ReactNode): ReactElement<Props>[] {
  if (Array.isArray(node)) return node.flatMap(controls);
  return isValidElement<Props>(node) ? [node, ...controls(node.props.children)] : [];
}
const render = (overrides: Partial<typeof props> = {}) => { host.index = 0; return SuggestionLetter({ ...props, ...overrides }); };
const control = (test: (node: ReactElement<Props>) => boolean) => controls(render()).find(test)!.props;
const send = () => control(node => node.props.type === 'submit');
const field = (id: string, value: string) => control(node => node.props.id === id).onChange!({ target: { value } });
const effort = (value: string) => control(node => node.type === 'input' && node.props.value === value).onChange!({ target: { value } });
const submit = () => control(node => node.type === 'form').onSubmit!({ preventDefault() {} });
beforeEach(() => { host.state = []; host.index = 0; vi.clearAllMocks(); host.invoke.mockReset(); });

it('offers the entry only with options from member detail, including older responses', () => {
  const entry = (value: MemberDetail) => { host.index = 0; return renderToStaticMarkup(AiSuggestion({ detail: value, closePanel: vi.fn() })); };
  expect(entry(detail)).not.toContain('AI 건의');
  expect(entry({ ...detail, aiSuggestion: null })).not.toContain('AI 건의');
  expect(entry({ ...detail, aiSuggestion: options })).toContain('AI 건의');
});

it('shows the actual kind, model, effort, catalog notes and replacement terms', () => {
  const markup = renderToStaticMarkup(render());
  expect(markup).toContain('Claude · sonnet · 노력치 보통 (medium)');
  for (const row of options.models) expect(markup).toContain(row.note);
  expect(markup).toMatch(/퇴직.*채용.*하던 일을 넘겨받습니다/);
  expect(renderToStaticMarkup(render({ fixed: false }))).not.toContain('팀원 교체 안내');
  expect(markup).toContain('바꿀지 유지할지');
});

it('enables sending only for an effective difference including cross-kind tier mappings', () => {
  expect(send().disabled).toBe(true);
  field('suggestion-reason', '설계 검토'); field('suggestion-model', 'sonnet'); effort('normal');
  expect(send().disabled).toBe(true);
  effort('high'); expect(send().disabled).toBe(false);
  effort('normal'); field('suggestion-model', 'gpt-6-sol'); expect(send().disabled).toBe(false);
  expect(renderToStaticMarkup(render())).toContain('Codex · 코드 구현과 검토');
  field('suggestion-model', '');
  const custom = { ...options, effortTiers: options.effortTiers.map(row => ({ ...row, values: { ...row.values, claude: 'medium', codex: 'xhigh' } })) };
  effort('high');
  expect(controls(render({ options: custom })).find(node => node.props.type === 'submit')!.props.disabled).toBe(true);
  field('suggestion-model', 'gpt-6-sol');
  expect(renderToStaticMarkup(render({ options: custom }))).toContain('xhigh');
});

it('compares against the configuration already scheduled for the next task', () => {
  const pending = { ...member, pendingAiChange: { ...member.ai, model: 'opus', effortTier: 'low' as const } };
  field('suggestion-model', 'opus'); effort('low');
  const tree = render({ member: pending });
  expect(renderToStaticMarkup(tree)).toContain('다음 작업부터');
  expect(controls(tree).find(node => node.props.type === 'submit')!.props.disabled).toBe(true);
});

it.each([
  ['gpt-6-sol', '', '', { model: 'gpt-6-sol' }],
  ['', 'high', '검토할 조건이 많습니다.', { effortTier: 'high' }],
  ['opus', 'high', '설계를 검토해 주세요.', { model: 'opus', effortTier: 'high' }],
] as const)('sends precisely the selected fields (%s, %s) and opens the project conversation', async (model, tier, reason, picks) => {
  if (model) field('suggestion-model', model);
  if (tier) effort(tier);
  field('suggestion-reason', reason);
  await submit();
  expect(host.invoke.mock.calls).toEqual([['command.send', { target: props.projectId, text: reason, aiSuggestion: { memberId: member.id, ...picks } }]]);
  expect(host.toast).toHaveBeenCalledWith('건의를 보냈습니다', expect.stringContaining('프로젝트 대화'));
  expect(host.open).toHaveBeenCalledWith(props.projectId);
  expect(props.sent).toHaveBeenCalledOnce();
});

it('reports progress, prevents a second send, then preserves the draft and the exact refusal', async () => {
  let reject!: (error: unknown) => void;
  host.invoke.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  field('suggestion-model', 'opus'); effort('high'); field('suggestion-reason', '설계 검토');
  const result = submit();
  expect(renderToStaticMarkup(render())).toContain('보내는 중…');
  expect(send().disabled).toBe(true); await submit(); expect(host.invoke).toHaveBeenCalledTimes(1);
  reject({ code: 'conflict', message: '이미 퇴직한 팀원입니다.' }); await result;
  expect(renderToStaticMarkup(render())).toContain('role="alert">이미 퇴직한 팀원입니다.');
  expect(control(node => node.type === 'select').value).toBe('opus');
  expect(control(node => node.props.value === 'high').checked).toBe(true);
  expect(control(node => node.type === 'textarea').value).toBe('설계 검토');
  expect(send().disabled).toBe(false);
  expect(host.open).not.toHaveBeenCalled(); expect(props.sent).not.toHaveBeenCalled();
});
