import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { vi.resetModules(); vi.stubGlobal('window', { wook: {}, location: { search: '' } }); });
afterEach(() => vi.unstubAllGlobals());

it.each([
  ['kind', 'Codex CLI(모델 gpt-6-sol, 노력치 high)'],
  ['model', 'Claude CLI(모델 changed-model, 노력치 high)'],
  ['effortTier', 'Claude CLI(CLI 기본 모델, 노력치 low)'],
  ['effortOverride', 'Claude CLI(CLI 기본 모델, 노력치 medium)'],
] as const)('S4-25-fake-conflict. stale %s refuses the whole patch with the backend wording', async (field, label) => {
  const { fakeBridge } = await import('./index');
  const { settings } = await import('./data');
  const loaded = structuredClone(settings.general.mainAgent);
  if (field === 'kind') settings.general.mainAgent.kind = loaded.kind === 'claude' ? 'codex' : 'claude';
  if (field === 'model') settings.general.mainAgent.model = 'changed-model';
  if (field === 'effortTier') settings.general.mainAgent.effortTier = loaded.effortTier === 'low' ? 'high' : 'low';
  if (field === 'effortOverride') settings.general.mainAgent.effortOverride = 'medium';
  const current = await fakeBridge.invoke('settings.get');
  await expect(fakeBridge.invoke('settings.update', { general: { mainAgent: loaded }, logs: { retentionDays: 47 } }, { mainAgent: loaded })).rejects.toMatchObject({
    code: 'conflict', message: `메인 AI가 그사이 ${label}로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요`,
  });
  expect(await fakeBridge.invoke('settings.get')).toEqual(current);
});

it('S4-37-fake-label. pins the default-model refusal and resolves effort through the configured mapping', async () => {
  const { fakeBridge } = await import('./index');
  const { settings } = await import('./data');
  const loaded = { ...settings.general.mainAgent, model: 'sonnet' };
  await expect(fakeBridge.invoke('settings.update', { general: { mainAgent: loaded } }, { mainAgent: loaded })).rejects.toMatchObject({
    code: 'conflict', message: '메인 AI가 그사이 Claude CLI(CLI 기본 모델, 노력치 high)로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요',
  });
  settings.general.mainAgent.effortTier = 'normal';
  settings.team.effortMapping.claude.normal = 'low';
  await expect(fakeBridge.invoke('settings.update', { general: { mainAgent: loaded } }, { mainAgent: loaded })).rejects.toMatchObject({
    code: 'conflict', message: '메인 AI가 그사이 Claude CLI(CLI 기본 모델, 노력치 low)로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요',
  });
});

it('S4-37-fake-codex-default. uses CLI default wording when Codex has neither a model nor a catalog default', async () => {
  const { fakeBridge } = await import('./index');
  const { settings } = await import('./data');
  settings.general.mainAgent.kind = 'codex';
  settings.team.modelCatalog = { claude: [], codex: [] };
  const stale = { ...settings.general.mainAgent, model: 'stale-model' };
  await expect(fakeBridge.invoke('settings.update', { general: { mainAgent: stale } }, { mainAgent: stale })).rejects.toMatchObject({
    code: 'conflict', message: '메인 AI가 그사이 Codex CLI(CLI 기본 모델, 노력치 high)로 바뀌었습니다. 아무것도 저장하지 않았습니다 — 바뀐 메인 AI를 확인한 뒤 다시 바꾸세요',
  });
});

it.each([false, true])('S4-37-fake-installation. stale expected is ignored without a mainAgent patch (general: %s)', async withGeneral => {
  const { fakeBridge } = await import('./index');
  const loaded = await fakeBridge.invoke('settings.get');
  const expected = { mainAgent: { ...loaded.general.mainAgent, model: 'stale-model' } };
  const patch = withGeneral ? { general: { launchAtLogin: !loaded.general.launchAtLogin }, logs: { retentionDays: 47 } } : { logs: { retentionDays: 47 } };
  await expect(fakeBridge.invoke('settings.update', patch, expected)).resolves.toMatchObject({ logs: { retentionDays: 47 } });
  const saved = await fakeBridge.invoke('settings.get');
  expect(saved.logs.retentionDays).toBe(47);
  expect(saved.general.mainAgent).toEqual(loaded.general.mainAgent);
  expect(saved.general.launchAtLogin).toBe(withGeneral ? !loaded.general.launchAtLogin : loaded.general.launchAtLogin);
});

it('S4-25-fake-save. matching expectation changes the main AI; installation patches leave it alone', async () => {
  const { fakeBridge } = await import('./index');
  const loaded = await fakeBridge.invoke('settings.get');
  const mainAgent = { ...loaded.general.mainAgent, model: 'sonnet' };
  const saved = await fakeBridge.invoke('settings.update', { general: { mainAgent } }, { mainAgent: loaded.general.mainAgent });
  expect(saved.general.mainAgent).toEqual(mainAgent);
  const installation = await fakeBridge.invoke('settings.update', { logs: { retentionDays: 47 } });
  expect(installation.logs.retentionDays).toBe(47);
  expect(installation.general.mainAgent).toEqual(mainAgent);
});
