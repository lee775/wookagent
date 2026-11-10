import { useEffect, useState } from 'react';
import { Save, Download, KeyRound } from 'lucide-react';
import type { AppSnapshot, PrereqStatus, RecoveryItemView, RoleView, SkillView, ActivityView, SystemInfo } from '../../../shared/views';
import type { AiKind, EffortTier, Settings, SettingsSection } from '../../../shared/domain';
import type { LogFilter } from '../../../shared/ipc';
import { ACTIVITY_KIND_LABEL, AI_KIND_LABEL, EFFORT_TIER_LABEL, MOCK_SCENARIO_LABEL, ROLE_CREATOR_LABEL, TASK_TYPE_LABEL, TASK_STATE_LABEL } from '../../../shared/labels';
import { EFFORT_LEVELS } from '../../../shared/domain';
import { call, toast } from '../api/store';
import { runtime } from '../api/runtime';
import { date, Empty, LabelValue, Section } from '../lib/ui';
import { PolicyTable } from '../components/PolicyTable';
import { ModelInput } from '../components/ModelInput';
import { MainPauseNotice } from '../components/MainPauseNotice';
import { installationPatch } from '../lib/installationSettings';
import { openCommand } from '../lib/commands';
import { EXECUTION_LIMITS, BACKUP_KEEP_LIMIT } from '../lib/operationLimits';
import { AiStatusSummary } from '../components/AiStatusSummary';
import { FileDownload } from '../components/FileDownload';
import { DeviceList } from '../components/DeviceList';

const sections: { id: SettingsSection; label: string }[] = [
  { id: 'general', label: '앱 정보' }, { id: 'account', label: '설치 설정' },
  { id: 'team', label: '팀과 역할' }, { id: 'execution', label: '실행' },
  { id: 'policy', label: '실행 정책·정지' }, { id: 'skills', label: '스킬' },
  { id: 'logs', label: '기록' }, { id: 'developer', label: '개발자 옵션' },
];
const kinds = ['claude', 'codex'] as const;
const executionFields = [
  ['maxConcurrent', '전체 CLI 실행 상한'], ['turnTimeoutMin', '턴 시간 상한 · 분'],
  ['claudeMaxTurns', 'Claude 최대 턴 수'], ['noOutputMin', '응답 없음 · 분'],
  ['commandMaxMin', '명령 상한 · 분'], ['healthCheckMin', '상태 확인 후 대기 · 분'],
  ['crashRetryMax', '비정상 종료 재개 최대 횟수'], ['spinSameErrorCount', '같은 오류 반복 횟수'],
  ['spinNoProgressMin', '진척 없음 · 분'], ['spinNoProgressResumes', '진척 없음 자동 재개 횟수'],
] as const;
function AiFields({
  kind,
  setKind,
  model,
  setModel,
  tier,
  setTier,
  override,
  setOverride,
  catalog,
}: {
  kind: AiKind;
  setKind: (value: AiKind) => void;
  model: string;
  setModel: (value: string) => void;
  tier: EffortTier;
  setTier: (value: EffortTier) => void;
  override: string;
  setOverride: (value: string) => void;
  catalog?: Settings['team']['modelCatalog'];
}) {
  return (
    <div className="form-grid">
      <label>
        AI 종류
        <select value={kind} onChange={(event) => setKind(event.target.value as AiKind)}>
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <label>
        모델
        <ModelInput kind={kind} catalog={catalog} value={model} onChange={setModel} placeholder="CLI 기본 모델" />
      </label>
      <label>
        노력치
        <select value={tier} onChange={(event) => setTier(event.target.value as EffortTier)}>
          <option value="high">높게</option>
          <option value="normal">보통</option>
          <option value="low">낮게</option>
        </select>
      </label>
      <label>
        실제 값 직접 지정
        <select value={override} onChange={(event) => setOverride(event.target.value)}><option value="">단계 설정 사용</option>{EFFORT_LEVELS[kind].map(level => <option key={level} value={level}>{level}</option>)}</select>
      </label>
    </div>
  );
}
function SystemInfoSection({ info, advanced = false }: { info: SystemInfo | null; advanced?: boolean }) {
  const runnerLabel = info
    ? {
        jobobject: 'Windows 작업 실행기',
        taskkill: '작업 종료 명령',
        pgroup: '프로세스 그룹',
      }[info.processRunner.mode]
    : '확인 중…';
  return (
    <Section title={advanced ? '개발 환경' : '앱 정보'}>
      <div className="system-info-grid">
        {!advanced && <>
        <strong>데이터 폴더</strong>
        <span>
          {info?.dataDir ?? '확인 중…'}
          {!runtime().web && <button disabled={!info?.dataDir} onClick={() => info && void call('system.openPath', info.dataDir).catch(() => undefined)}>
            열기
          </button>}
        </span>
        <strong>버전</strong>
        <span>{info ? `${info.appVersion.replace('-dev', '')} · ${info.isPackaged ? '설치된 앱' : '개발 실행'} · ${info.platform === 'win32' ? 'Windows' : info.platform}` : '확인 중…'}</span>
        </>}
        {advanced && <>
        <strong>하위 프로세스 종료 방식</strong>
        <span>
          {runnerLabel}
        </span>
        <strong>앱 도구 서버 주소</strong>
        <span>{info?.toolServerUrl ?? '연결되지 않음'}</span>
        </>}
      </div>
    </Section>
  );
}

export function SettingsScreen({ snapshot, section, setSection, logout, openTask, deviceListVisit = 0 }: {
  snapshot: AppSnapshot; section: SettingsSection; setSection: (value: SettingsSection) => void;
  logout: () => void; openTask: (id: string) => void;
  deviceListVisit?: number;
}) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [roles, setRoles] = useState<RoleView[]>([]);
  const [skills, setSkills] = useState<SkillView[]>([]);
  const [recovery, setRecovery] = useState<RecoveryItemView[]>([]);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [prereqs, setPrereqs] = useState<PrereqStatus | null>(null);
  const [secret, setSecret] = useState('');
  const [keys, setKeys] = useState<Record<AiKind, string>>({ claude: '', codex: '' });
  const [logFilter, setLogFilter] = useState<LogFilter>({ limit: 100 });
  const [logs, setLogs] = useState<ActivityView[]>([]);
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [mockOffProjects, setMockOffProjects] = useState<string[]>([]);
  const desktop = runtime(snapshot).desktop;
  const holderAi = snapshot.seat.holder?.kind === 'launched' ? JSON.stringify(snapshot.seat.holder.ai) : null;
  useEffect(() => {
    let active = true;
    void call('settings.get').then(value => {
      if (!active) return;
      setSettings(value);
      setDraft(old => old ? { ...old, general: { ...old.general, mainAgent: structuredClone(value.general.mainAgent) } } : structuredClone(value));
    }).catch(() => undefined);
    return () => { active = false; };
  }, [section, snapshot.seat.generation, snapshot.seat.state, holderAi]);
  useEffect(() => {
    void call('skills.list').then(setSkills).catch(() => undefined);
    void call('recovery.list').then(setRecovery).catch(() => undefined);
    void call('system.info').then(setInfo).catch(() => undefined);
    void call('system.prereqs').then(setPrereqs).catch(() => undefined);
  }, [section]);
  useEffect(() => {
    let active = true;
    void call('roles.list').then(value => { if (active) setRoles(value); }).catch(() => undefined);
    return () => { active = false; };
  }, [section, snapshot.version]);
  useEffect(() => { if (section === 'logs') void call('logs.search', logFilter).then(setLogs).catch(() => undefined); }, [section, snapshot.version]);
  const saveInstallation = async (value: Settings) => {
    if (!desktop || saving) return;
    setSaving(true);
    try {
      const next = await call('settings.update', installationPatch(value));
      setSettings(next); setDraft(structuredClone(next)); setNotice('설치 설정을 저장했습니다.');
    } catch { /* 공통 오류 안내 */ }
    finally { setSaving(false); }
  };
  const turnMockOff = async (projectId?: string) => {
    if (!desktop || saving) return;
    setSaving(true);
    try {
      if (projectId) {
        await call('projects.setMock', projectId, { enabled: false });
        setMockOffProjects(old => [...old, projectId]);
      } else {
        const next = await call('settings.update', { developer: { mainAgentMock: false } });
        setSettings(next); setDraft(structuredClone(next));
      }
      setNotice('모의 실행을 껐습니다. 다음 턴부터 실제 AI CLI로 실행됩니다.');
    } catch { /* 공통 오류 안내 */ }
    finally { setSaving(false); }
  };
  if (!settings || !draft) return <div className="screen">설정을 불러오는 중…</div>;
  const s = settings;
  return <div className="screen settings-screen">
    <div className="page-heading"><div><span className="eyebrow">설정과 기록</span><h1>운영 설정</h1><p>{desktop ? '팀 운영은 메인 에이전트가 맡습니다. 이 PC의 설치 설정은 직접 바꿀 수 있습니다.' : '로그인한 기기와 서버 설정을 확인합니다. 팀 운영은 메인 에이전트가 맡습니다.'}</p></div><button onClick={() => openCommand(null, '운영 설정에 대해: ')}>메인 에이전트에게 말하기</button></div>
    <div className="settings-layout"><nav className="settings-nav" aria-label="설정 분류">{sections.map(item => <button key={item.id} className={section === item.id ? 'active' : ''} onClick={() => { setNotice(''); setSection(item.id); }}>{item.id === 'account' && snapshot.auth.mode === 'server' ? '계정과 기기' : item.label}</button>)}</nav>
    <div className="settings-content">
    {section === 'general' && <><SystemInfoSection info={info} /><Section title="자동 백업"><LabelValue label="자동 백업">{s.general.backup.enabled ? '켜짐' : '꺼짐'}</LabelValue><LabelValue label="백업 보관 개수">{s.general.backup.keep}개<small className="value-range">허용 범위 {BACKUP_KEEP_LIMIT.min}~{BACKUP_KEEP_LIMIT.max}개</small></LabelValue><p className="muted">보관 개수 변경과 수동 백업은 메인 에이전트가 처리합니다.</p></Section></>}
    {section === 'account' && <>
      <Section title="대표 계정"><p>{snapshot.auth.owner?.name} · {snapshot.auth.owner?.email}</p><button onClick={logout}>로그아웃</button></Section>
      <DeviceList auth={snapshot.auth} version={snapshot.version} focusRequest={deviceListVisit} />
      {desktop && <Section title="설치 설정"><p className="muted">{snapshot.auth.mode === 'server' ? '서버의 로그인, AI 연결, 보안과 기록 보관 설정입니다.' : '이 PC의 로그인, AI 연결, 보안과 기록 보관 설정입니다.'}</p>{!desktop && <p className="hint">설치·운영자 설정은 서버 PC의 운영자가 바꿉니다.</p>}
      <fieldset className="installation-fields" disabled={!desktop}>
        <div className="readonly-account"><strong>대표 이메일</strong><p>{snapshot.auth.owner?.email ?? '등록된 이메일 없음'}</p><small>현재 로그인한 대표 계정입니다. 이 화면에서는 바꿀 수 없습니다.</small></div>
        <label>Google 클라이언트 ID<input value={draft.account.googleClientId} onChange={e => setDraft({ ...draft, account: { ...draft.account, googleClientId: e.target.value } })} /></label>
        <label>Google 클라이언트 보안 비밀<input type="password" value={secret} onChange={e => setSecret(e.target.value)} placeholder={s.account.googleClientSecretSet ? '등록됨 · 새 값 입력' : '보안 비밀 입력'} autoComplete="new-password" /></label>
        <button disabled={!secret.trim()} onClick={() => void call('settings.setGoogleSecret', secret).then(() => { setSecret(''); setNotice('보안 비밀을 저장했습니다.'); }).catch(() => undefined)}>보안 비밀 저장</button>
        <h3>모의 실행</h3>
        {s.developer.mainAgentMock && <div className="mock-off-card"><p>메인 에이전트가 모의 실행으로 돌고 있습니다. 모의 실행은 개발·시험용이라 실제 AI CLI를 쓰지 않습니다.</p>{desktop && <button disabled={saving} onClick={() => void turnMockOff()}>모의 실행 끄기</button>}</div>}
        {snapshot.projects.filter(project => project.mock.enabled && !mockOffProjects.includes(project.id)).map(project => <div className="mock-off-card" key={project.id}><p>프로젝트 {project.name}{/[가-힣]$/.test(project.name) && (project.name.charCodeAt(project.name.length - 1) - 44032) % 28 === 0 ? '가' : '이'} 모의 실행으로 돌고 있습니다.</p>{desktop && <button disabled={saving} onClick={() => void turnMockOff(project.id)}>모의 실행 끄기</button>}</div>)}
        {!s.developer.mainAgentMock && !snapshot.projects.some(project => project.mock.enabled && !mockOffProjects.includes(project.id)) && <p className="muted">모의 실행이 꺼져 있습니다.</p>}
        {notice && <p className="hint" role="status">{notice}</p>}
        <h3>AI 인증 방식과 API 키</h3>
        {kinds.map(kind => <div className="installation-ai" key={kind}><strong>{AI_KIND_LABEL[kind]}</strong><label>AI 인증 방식<select value={draft.account.authMode[kind]} onChange={e => setDraft({ ...draft, account: { ...draft.account, authMode: { ...draft.account.authMode, [kind]: e.target.value } } })}><option value="subscription">구독</option><option value="api_key">API 키</option></select><small>결제 방식을 바꾸거나 API 키 방식에서 키를 새로 등록하면, 걸려 있던 사용량 한도를 지우고 한 번 다시 시도합니다.</small></label><label>API 키<input type="password" value={keys[kind]} autoComplete="new-password" placeholder="키는 보안 저장소에 보관됩니다" onChange={e => setKeys({ ...keys, [kind]: e.target.value })} /></label><button disabled={!keys[kind].trim()} onClick={() => void call('settings.setApiKey', kind, keys[kind]).then(() => { setKeys(old => ({ ...old, [kind]: '' })); setNotice(`${AI_KIND_LABEL[kind]} API 키를 저장했습니다.`); }).catch(() => undefined)}><KeyRound size={15} /> API 키 저장</button><button onClick={() => { if (window.confirm(`${AI_KIND_LABEL[kind]} API 키를 삭제할까요?`)) void call('settings.setApiKey', kind, null).then(() => setNotice(`${AI_KIND_LABEL[kind]} API 키를 삭제했습니다.`)).catch(() => undefined); }}>API 키 삭제</button></div>)}
        <h3>CLI 실행 파일 위치</h3><div className="form-grid">{(['claudePath', 'codexPath'] as const).map((key, index) => <label key={key}>{index === 0 ? 'Claude' : 'Codex'} CLI 경로<input value={draft.cli[key] ?? ''} placeholder="비워 두면 자동으로 찾습니다" onChange={e => setDraft({ ...draft, cli: { ...draft.cli, [key]: e.target.value || null } })} /></label>)}</div>
        <h3>보안 정책</h3><label>긴급 정지 단축키<input value={draft.policy.emergencyShortcut} onChange={e => setDraft({ ...draft, policy: { ...draft.policy, emergencyShortcut: e.target.value } })} placeholder="Ctrl+Shift+F12" /></label>
        {draft.policy.sensitiveAreas.map((area, index) => <label key={area.kind}>민감 영역 · {{ system: '시스템', personal: '개인 파일', secret: '비밀 정보', app: '앱 데이터' }[area.kind]}<textarea rows={3} value={area.paths.join('\n')} onChange={e => setDraft({ ...draft, policy: { ...draft.policy, sensitiveAreas: draft.policy.sensitiveAreas.map((item, i) => i === index ? { ...item, paths: e.target.value.split('\n') } : item) } })} /></label>)}
        <label>기록 보관 기간 · 일<input type="number" min="1" value={draft.logs.retentionDays} onChange={e => setDraft({ ...draft, logs: { retentionDays: Number(e.target.value) } })} /></label>
        <label className="checkbox-row"><input type="checkbox" checked={draft.general.backup.enabled} onChange={e => setDraft({ ...draft, general: { ...draft.general, backup: { ...draft.general.backup, enabled: e.target.checked } } })} />자동 백업 켜기</label>
        <label className="checkbox-row"><input type="checkbox" checked={draft.general.launchAtLogin} onChange={e => setDraft({ ...draft, general: { ...draft.general, launchAtLogin: e.target.checked } })} />로그인 때 실행</label>
        {desktop && <button className="primary-button" disabled={saving} onClick={() => void saveInstallation(draft)}><Save size={15} /> 설치 설정 저장</button>}
      </fieldset></Section>}
      {desktop && <Section title="메인 에이전트 AI"><fieldset className="installation-fields" disabled={!desktop}><AiConfigForm value={s.general.mainAgent} catalog={s.team.modelCatalog} effortMapping={s.team.effortMapping} saved={next => {
        setSettings(next);
        setDraft(old => old ? { ...old, general: { ...old.general, mainAgent: structuredClone(next.general.mainAgent) } } : structuredClone(next));
      }} /></fieldset><p className="muted">바꾸면 운영자 배정으로 기록됩니다. AI 종류를 바꾸면 새 세대가 되고, 모델이나 노력치만 바꾸면 다음 턴부터 적용됩니다.</p></Section>}
      {notice && <p className="hint" role="status">{notice}</p>}
      <Section title="CLI 준비 상태">{prereqs && <><p>Git: {prereqs.git.ok ? '설치됨' : '설치 필요'}</p>{kinds.map(kind => <div key={kind}><strong>{AI_KIND_LABEL[kind]}</strong><p>{prereqs[kind].detail}</p><button onClick={() => void call('system.recheckAi', kind).then(() => call('system.prereqs')).then(setPrereqs).catch(() => undefined)}>다시 확인</button></div>)}<div className="screen-prereq"><strong>화면 도구</strong><p>{prereqs.screen.detail}</p></div><div className="runner-prereq"><strong>작업 개체 도우미</strong><p>{prereqs.jobRunner.detail}</p></div></>}</Section>
    </>}
    {section === 'team' && <>
      <Section title="팀원 AI"><p>팀원별 AI와 역할은 메인 에이전트가 판단해 정합니다.</p></Section>
      <Section title="모델 목록">{kinds.map(kind => <div key={kind}><h3>{AI_KIND_LABEL[kind]}</h3>{s.team.modelCatalog?.[kind].length ? s.team.modelCatalog[kind].map(model => <p key={model.id}><strong>{model.label}</strong> · {model.id}<br />{model.note}</p>) : <p>CLI 기본 모델</p>}</div>)}</Section>
      <Section title="노력치 단계 연결"><div className="table-scroll"><table><thead><tr><th>AI</th><th>높게</th><th>보통</th><th>낮게</th></tr></thead><tbody>{kinds.map(kind => <tr key={kind}><th>{AI_KIND_LABEL[kind]}</th>{(['high', 'normal', 'low'] as const).map(tier => <td key={tier}>{s.team.effortMapping[kind][tier]}</td>)}</tr>)}</tbody></table></div></Section>
      <Section title="역할 정의">{roles.map(role => <div className="role-row" key={role.id}><div><strong>{role.name}</strong>{role.createdBy && <span className="role-creator">{ROLE_CREATOR_LABEL[role.createdBy]}</span>}<p>{role.instructions}</p><small>{AI_KIND_LABEL[role.defaultAi.kind]} · {role.defaultAi.model ?? '기본 모델'} · {EFFORT_TIER_LABEL[role.defaultAi.effortTier]} ({role.defaultAi.effortOverride ?? s.team.effortMapping[role.defaultAi.kind][role.defaultAi.effortTier]}) · {role.canReview ? '검수 가능' : '검수 없음'}</small><p>담당 유형: {role.taskTypes.map(type => TASK_TYPE_LABEL[type]).join(', ') || '없음'}</p><p>허용 스킬: {role.allowedSkills.join(', ') || '없음'}</p></div></div>)}</Section>
    </>}
    {section === 'execution' && <Section title="실행 설정"><p className="muted">실행 상한과 오류 기준은 메인 에이전트가 관리합니다.</p><div className="detail-grid">{executionFields.map(([key, label]) => <LabelValue key={key} label={label}>{s.execution[key] ?? '제한 없음'}<small className="value-range">허용 범위 {EXECUTION_LIMITS[key].min}~{EXECUTION_LIMITS[key].max}{EXECUTION_LIMITS[key].unit}{key === 'claudeMaxTurns' ? ' 또는 제한 없음' : ''}</small></LabelValue>)}<LabelValue label="절전 방지">{s.execution.preventSleep ? '켜짐' : '꺼짐'}</LabelValue></div></Section>}
    {section === 'policy' && <>
      <Section title="운영 상태">{snapshot.ai.map(ai => <AiStatusSummary key={ai.kind} ai={ai} />)}</Section><PolicyTable server={runtime(snapshot).server} /><MainPauseNotice snapshot={snapshot} />
      <Section title="프로젝트 실행 정책">{snapshot.projects.map(project => <div className="review-entry" key={project.id}><strong>{project.name}</strong><p>{project.networkPolicy === 'allow' ? '네트워크 허용' : '네트워크 제한 지침'}</p><pre>{project.checkCommands.join('\n') || '자동 검사 명령 없음'}</pre></div>)}</Section>
      <Section title="저장된 정지와 보류"><p className="muted">각 작업의 보류 사유에서 전달 상태를 확인하세요. 필요한 조치는 명령창으로 메인 에이전트에게 알려 주세요.</p><div className="hold-list">{snapshot.stop.pausedProjects.map(item => <p key={item.projectId}>프로젝트 · {snapshot.projects.find(p => p.id === item.projectId)?.name} · {item.reason} · {date(item.since)}</p>)}{snapshot.stop.pausedMembers.map(item => <p key={item.memberId}>팀원 · {snapshot.members.find(m => m.id === item.memberId)?.name} · {item.reason} · {date(item.since)}</p>)}{snapshot.tasks.filter(t => t.state === 'on_hold').map(task => <div key={task.id}><button className="text-button" onClick={() => openTask(task.id)}>{task.title}</button><p>{task.hold?.reasons.map(r => r.label).join(', ')} · 복귀: {task.hold?.returnState ? TASK_STATE_LABEL[task.hold.returnState] : '미정'}</p></div>)}</div></Section>
      <Section title="복구 확인"><p className="muted">홈에서 복구 항목의 전달 상태를 확인하세요. 메인 에이전트에게 확인이나 처리를 요청할 수 있습니다.</p>{recovery.map(item => <div className="recovery-card" key={item.requestId}><strong>{item.kind === 'auto_check' ? '자동 검사 확인' : '실행 결과 확인'}</strong><p>{item.finding}</p><code>{item.command}</code>{item.taskId && <button onClick={() => openTask(item.taskId!)}>작업 보기</button>}<button onClick={() => openCommand(item.projectId, `복구 확인 ${item.requestId}에 대해: `)}>메인 에이전트에게 말하기</button></div>)}{!recovery.length && <Empty text="복구 확인 항목이 없습니다." />}</Section>
    </>}
    {section === 'skills' && <Section title="스킬 목록"><p className="muted">사용 방식과 허용 역할은 메인 에이전트가 관리합니다.</p>{skills.map(skill => <div className="review-entry" key={skill.name}><strong>{skill.name}</strong><p>{skill.description}</p><small>{AI_KIND_LABEL[skill.source]} · {skill.mode === 'auto' ? '자동' : '수동'}</small><p>허용 역할: {skill.allowedRoles.map(id => roles.find(role => role.id === id)?.name ?? id).join(', ') || '없음'}</p><code>{skill.path}</code></div>)}</Section>}
    {section === 'logs' && <Section title="활동 기록 검색"><div className="filter-row"><input aria-label="기록 내용 검색" placeholder="내용 검색" value={logFilter.text ?? ''} onChange={e => setLogFilter({ ...logFilter, text: e.target.value })} /><select aria-label="기록 프로젝트" value={logFilter.projectId ?? ''} onChange={e => setLogFilter({ ...logFilter, projectId: e.target.value || undefined })}><option value="">모든 프로젝트</option>{snapshot.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select><select aria-label="기록 수준" value={logFilter.level ?? ''} onChange={e => setLogFilter({ ...logFilter, level: e.target.value === 'info' || e.target.value === 'warn' || e.target.value === 'error' ? e.target.value : undefined })}><option value="">모든 수준</option><option value="info">정보</option><option value="warn">경고</option><option value="error">오류</option></select><label>시작일<input type="date" value={logFilter.from ?? ''} onChange={e => setLogFilter({ ...logFilter, from: e.target.value })} /></label><label>종료일<input type="date" value={logFilter.to ?? ''} onChange={e => setLogFilter({ ...logFilter, to: e.target.value })} /></label><button onClick={() => void call('logs.search', logFilter).then(setLogs).catch(() => undefined)}>검색</button><button onClick={() => void call('logs.export', logFilter).then(value => { setExportPath(value.path); toast('기록을 내보냈습니다', runtime().web ? '내려받기 링크를 눌러 저장하세요.' : value.path, 'info'); }).catch(() => undefined)}><Download size={15} /> 내보내기</button>{exportPath && <FileDownload target={{ kind: 'export', path: exportPath }} path={exportPath}>{runtime().web ? '내보낸 기록 내려받기' : '내보낸 기록 열기'}</FileDownload>}</div><div className="table-scroll"><table><thead><tr><th>시각</th><th>주체</th><th>종류</th><th>내용</th></tr></thead><tbody>{logs.map(item => <tr key={item.seq}><td>{date(item.ts)}</td><td>{item.actorName}</td><td>{ACTIVITY_KIND_LABEL[item.kind]}</td><td>{item.text}</td></tr>)}</tbody></table></div></Section>}
    {section === 'developer' && <><SystemInfoSection info={info} advanced /><Section title="모의 실행 상태"><LabelValue label="메인 에이전트 모의 모드">{s.developer.mainAgentMock ? '켜짐' : '꺼짐'}</LabelValue><LabelValue label="기본 진행 속도">{s.developer.mockSpeed}</LabelValue>{snapshot.projects.map(project => <p key={project.id}><strong>{project.name}</strong> · {project.mock.enabled ? '모의 실행' : '실제 실행'} · 속도 {project.mock.speed} · {MOCK_SCENARIO_LABEL[project.mock.defaultScenario]}</p>)}<p className="muted">개발자 옵션은 조회만 할 수 있습니다.</p></Section></>}
    </div></div>
  </div>;
}
function AiConfigForm({
  value,
  catalog,
  effortMapping,
  saved,
}: {
  value: Settings['general']['mainAgent'];
  catalog?: Settings['team']['modelCatalog'];
  effortMapping: Settings['team']['effortMapping'];
  saved: (settings: Settings) => void;
}) {
  const [loaded, setLoaded] = useState(value);
  const [kind, setKind] = useState<AiKind>(value.kind);
  const [model, setModel] = useState(value.model ?? '');
  const [tier, setTier] = useState<EffortTier>(value.effortTier);
  const [override, setOverride] = useState(value.effortOverride ?? '');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    setLoaded(value); setKind(value.kind); setModel(value.model ?? '');
    setTier(value.effortTier); setOverride(value.effortOverride ?? '');
  }, [value]);
  const save = async () => {
    if (saving) return;
    setSaving(true); setNotice('');
    try {
      const next = await call('settings.update', { general: { mainAgent: {
        kind, model: model || null, effortTier: tier, effortOverride: override || null,
      } } }, { mainAgent: loaded });
      saved(next); setNotice('메인 AI를 저장했습니다.');
    } catch { /* 공통 오류 안내. 충돌 시 자동으로 다시 저장하지 않습니다. */ }
    finally { setSaving(false); }
  };
  return (
    <fieldset className="installation-fields" disabled={saving}>
      <AiFields
        {...{
          kind,
          setKind,
          model,
          setModel,
          tier,
          setTier,
          override,
          setOverride,
          catalog,
        }}
      />
      <p className="muted">선택한 노력치: {EFFORT_TIER_LABEL[tier]} · 실제 값 {override || effortMapping[kind][tier]}</p>
      <button
        className="primary-button"
        disabled={saving}
        onClick={() => void save()}
      >
        <Save size={15} /> 저장
      </button>
      {notice && <p className="hint" role="status">{notice}</p>}
    </fieldset>
  );
}
