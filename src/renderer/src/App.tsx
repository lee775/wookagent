import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Bell,
  BriefcaseBusiness,
  FileText,
  Clapperboard,
  Settings2,
  OctagonAlert,
  X,
  ChevronRight,
  CheckCheck,
  Search,
} from 'lucide-react';
import type { NavTarget, SettingsSection } from '../../shared/domain';
import type { AppSnapshot, AuthState, EmergencySummary, NotificationView } from '../../shared/views';
import { TASK_STATE_LABEL } from '../../shared/labels';
import { getBridge } from './api/bridge';
import { call, toast, useSnapshot, useToasts } from './api/store';
import { date, Modal } from './lib/ui';
import { CommandBar } from './components/CommandBar';
import { MemberPanel } from './components/MemberPanel';
import { TaskDetail } from './components/TaskDetail';
import { DirectiveDetail } from './components/TaskDetail';
import { Home } from './screens/Home';
import { Studio } from './screens/Studio';
import { Documents } from './screens/Documents';
import { Simulation } from './screens/Simulation';
import { SettingsScreen } from './screens/Settings';
import { SettingsBoundary } from './components/SettingsBoundary';
import { ServerNotice } from './components/ServerNotice';
import { noticeTitle } from './lib/notice';
import { OfficeIntro } from './studio/Office';
import { resolveDisplayText } from './lib/displayText';
import { emergencyFailureKey, emergencyHeadline } from './lib/taskSignals';
import { MainPauseNotice, releaseStop } from './components/MainPauseNotice';
import { subscribeCommand } from './lib/commands';
import { PoseSheet } from './studio/PoseSheet';
import { OwnerSetup, ServerLogin } from './components/ServerLogin';
import { SeatChip, SeatUnresponsive } from './components/SeatStatus';
import { SeatScreen } from './screens/Seat';
import type { RendererTarget } from './lib/seat';
import './styles/seat.css';
type Tab = NavTarget['tab'];
const paletteTargets = [['프로젝트', 'projects'], ['문서함', 'documents'], ['시뮬레이션', 'simulation'], ['운영 설정', 'settings'], ['자리와 인계', 'seat']] as const;
function BrandMark() {
  return <span className="logo-mark" aria-label="욱채"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M2 3h28v24l-5 3H2z" fill="#246879" /><path d="M23 3h7v8h-7z" fill="#c07852" /><text x="6" y="24" fill="#fff" fontSize="21" fontWeight="800" fontFamily="Pretendard Variable, sans-serif">욱</text></svg></span>;
}
function HomeNavIcon() {
  return <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" d="M8 1.4 1.5 7v7.1h13V7L8 1.4Zm-2 8.4h4v4.3H6V9.8Z" /></svg>;
}
const capture = !window.wook ? new URLSearchParams(window.location.search).get('capture') : null;
function Login({ login, auth }: { login: (dev: boolean) => Promise<boolean>; auth?: AuthState }) {
  const [state, setState] = useState<AuthState | null>(auth ?? null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [setupMessage, setSetupMessage] = useState('');
  useEffect(() => {
    void call('auth.getState')
      .then(setState)
      .catch(() => undefined);
  }, []);
  const configureGoogle = async (event: FormEvent) => {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) { setSetupMessage('클라이언트 ID와 보안 비밀을 모두 입력해 주세요.'); return; }
    setSaving(true);
    setSetupMessage('');
    try {
      await call('settings.update', { account: { googleClientId: clientId.trim() } });
      setState(await call('auth.getState'));
      await call('settings.setGoogleSecret', clientSecret.trim());
      setClientSecret('');
      setState(await call('auth.getState'));
      setSetupOpen(false);
      setSetupMessage('설정을 저장했습니다. 이제 Google 계정으로 로그인할 수 있습니다.');
    } catch (error) {
      setSetupMessage(error instanceof Error ? error.message : '설정을 저장하지 못했습니다. 입력 내용을 확인해 주세요.');
    } finally { setSaving(false); }
  };
  const setupAvailable = state ? (state.googleSetupOpen ?? !state.ownerRegistered) : false;
  const attemptGoogle = async () => {
    setLoggingIn(true);
    try {
      if (!await login(false)) {
        const next = await call('auth.getState');
        setState(next);
        if (next.googleSetupOpen ?? !next.ownerRegistered) setSetupOpen(true);
      }
    } finally { setLoggingIn(false); }
  };
  if (state?.setupRequired) return <OwnerSetup onSetup={setState} />;
  if (state?.mode === 'server') return <ServerLogin />;
  return (
    <main className="login-screen">
      <div className="login-art">
        <OfficeIntro />
        <span className="login-art-caption">욱채 작업실</span>
      </div>
      <div className="login-card">
        <BrandMark />
        <h1>욱채</h1>
        <p>프로젝트와 팀의 작업을 확인합니다.</p>
        <button className="primary-button login-button" onClick={() => void attemptGoogle()} disabled={loggingIn || !state?.googleConfigured || !(state.googleSecretSet || state.googleSetupOpen === false)}>
          {loggingIn ? 'Google 로그인 중…' : 'Google 계정으로 로그인'} <ChevronRight size={18} />
        </button>
        {state?.devLoginAllowed && (
          <button className="login-dev" onClick={() => void login(true)}>
            개발 모드로 시작하기
          </button>
        )}
        {state && setupAvailable && state.googleConfigured && state.googleSecretSet && !setupOpen && <button className="login-reconfigure" onClick={() => setSetupOpen(true)}>로그인 설정 다시 입력</button>}
        {state?.ownerRegistered && setupAvailable && state.googleConfigured && state.googleSecretSet && !setupOpen && <p className="login-guidance">로그인 설정이 바뀌었다면 다시 입력한 뒤 로그인하세요.</p>}
        {state && setupAvailable && (!state.googleConfigured || !state.googleSecretSet || setupOpen) && (
          <form className="login-setup" onSubmit={event => void configureGoogle(event)}>
            <strong>Google 로그인 설정</strong>
            <p className="login-guidance">{state.ownerRegistered ? '구글 로그인 설정이 빠졌거나 마지막 로그인 뒤에 바뀌었습니다. 로그인이 안 되면 여기서 다시 입력하세요. 등록된 대표 계정으로만 로그인됩니다.' : 'Google Cloud에서 데스크톱 앱용 OAuth 클라이언트를 만든 뒤 ID와 보안 비밀을 입력해 주세요. 첫 로그인 계정이 대표로 등록됩니다.'}</p>
            <label>클라이언트 ID<input value={clientId} onChange={event => setClientId(event.target.value)} placeholder="…apps.googleusercontent.com" autoComplete="off" /></label>
            <label>보안 비밀<input type="password" value={clientSecret} onChange={event => setClientSecret(event.target.value)} autoComplete="new-password" /></label>
            <button type="submit" disabled={saving}>{saving ? '저장 중…' : '로그인 설정 저장'}</button>
            {setupMessage && <p role="status">{setupMessage}</p>}
          </form>
        )}
        {state?.googleConfigured && state.googleSecretSet && !setupOpen && setupMessage && <p className="login-guidance" role="status">{setupMessage}</p>}
      </div>
    </main>
  );
}
function EmergencyModal({ summary, close, openTask, snapshot }: { summary: EmergencySummary; close: () => void; openTask: (id: string) => void; snapshot: AppSnapshot }) {
  return (
    <Modal title="긴급 정지 결과" onClose={close} wide>
      <div className={`emergency-result ${summary.completed ? '' : 'failed'}`}>
        <OctagonAlert size={24} />
        <div>
          <strong>{emergencyHeadline(summary)}</strong>
          <p>
            {date(summary.at)} · 중지한 턴 {summary.stoppedTurns.length}개 · 보류한 작업 {summary.heldTasks.length}개
          </p>
        </div>
      </div>
      <h3>멈춘 턴</h3>
      {summary.stoppedTurns.map((turn) => (
        <div className="summary-row" key={turn.turnId}>
          <span>
            {turn.memberName}
          </span>
          <span>
            {turn.ok ? '종료 확인' : '종료 실패'} · {resolveDisplayText(turn.detail, snapshot)}
          </span>
        </div>
      ))}
      <h3>중간 상태의 작업</h3>
      {summary.heldTasks.map((task) => (
        <button
          className="summary-row"
          key={task.taskId}
          onClick={() => {
            close();
            openTask(task.taskId);
          }}
        >
          <span>
            {task.title}
          </span>
          <span>이전 상태 {TASK_STATE_LABEL[task.previousState]} → 보류</span>
        </button>
      ))}
      {summary.failures.length > 0 && (
        <>
          <h3>종료 실패</h3>
          {summary.failures.map((failure, index) => (
            <p className="warning emergency-failure" key={emergencyFailureKey(failure.memberId, index)}>
              <strong>{failure.memberName}</strong><span className="failure-tag">{failure.remaining === -1 ? '확인하지 못함' : '남은 프로세스 있음'}</span>
              <span>{resolveDisplayText(failure.detail, snapshot)}</span>
            </p>
          ))}
        </>
      )}
      <div className="modal-actions">
        <button className="primary-button" onClick={close}>
          확인
        </button>
      </div>
    </Modal>
  );
}
export function App() {
  const snapshot = useSnapshot();
  const [unauthorized, setUnauthorized] = useState(false);
  useEffect(() => {
    const onUnauthorized = () => setUnauthorized(true);
    const onAuthorized = () => setUnauthorized(false);
    window.addEventListener('wook:unauthorized', onUnauthorized);
    window.addEventListener('wook:authorized', onAuthorized);
    return () => {
      window.removeEventListener('wook:unauthorized', onUnauthorized);
      window.removeEventListener('wook:authorized', onAuthorized);
    };
  }, []);
  const { items: toasts, dismiss } = useToasts();
  const [tab, setTab] = useState<Tab>(capture === 'documents' ? 'documents' : capture === 'settings' ? 'settings' : 'projects');
  const [projectId, setProjectId] = useState<string | null>(() =>
    !window.wook && new URLSearchParams(window.location.search).has('officeDemo') && !['home', 'member', 'documents', 'settings'].includes(capture ?? '') ? 'P-0003' : null);
  const [memberId, setMemberId] = useState<string | null>(capture === 'member' ? 'M-0016' : null);
  const [taskId, setTaskId] = useState<string | null>(capture?.startsWith('task-') ? capture.slice(5) : null);
  const [directiveId, setDirectiveId] = useState<string | null>(null);
  useEffect(() => subscribeCommand(() => { setMemberId(null); setTaskId(null); setDirectiveId(null); }), []);
  const [reportId, setReportId] = useState<string | null>(capture === 'documents' ? 'R-0001' : null);
  const [docProjectId, setDocProjectId] = useState<string | null>(null);
  const [section, setSection] = useState<SettingsSection>('general');
  const [deviceListVisit, setDeviceListVisit] = useState(0);
  const [notifications, setNotifications] = useState<NotificationView[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [emergency, setEmergency] = useState<EmergencySummary | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [paletteIndex, setPaletteIndex] = useState(0);
  const navigate = useCallback((target: RendererTarget) => {
    setDeviceListVisit(0);
    setMemberId(null); setTaskId(null); setDirectiveId(null);
    if (target.tab === 'question') {
      setTab('projects'); setProjectId(null);
      requestAnimationFrame(() => {
        const question = document.getElementById(`question-${target.questionId}`);
        question?.scrollIntoView({ block: 'center' });
        question?.querySelector('textarea')?.focus({ preventScroll: true });
      });
      return;
    }
    setTab(target.tab);
    if (target.tab === 'projects') {
      setProjectId(target.projectId ?? null);
      if (target.memberId) setMemberId(target.memberId);
      if (target.taskId) setTaskId(target.taskId);
      if (target.directiveId) setDirectiveId(target.directiveId);
    }
    if (target.tab === 'documents') {
      setDocProjectId(target.projectId ?? null);
      setReportId(target.reportId ?? null);
    }
    if (target.tab === 'settings') setSection(target.section ?? 'general');
  }, []);
  useEffect(() => {
    const bridge = getBridge();
    const offNotification = bridge.subscribe('notification', (item) => {
      toast(noticeTitle(item), item.body, item.level);
      void call('notifications.list', {
        limit: 50,
      })
        .then(setNotifications)
        .catch(() => undefined);
    });
    const offNavigate = bridge.subscribe('navigate', navigate);
    const offEmergency = bridge.subscribe('emergency', setEmergency);
    const offSettings = bridge.subscribe('openSettings', (value) =>
      navigate({
        tab: 'settings',
        section: value.section,
      }),
    );
    return () => {
      offNotification();
      offNavigate();
      offEmergency();
      offSettings();
    };
  }, [navigate]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault(); setPaletteOpen(open => !open);
      }
      if (event.key === 'Escape') setPaletteOpen(false);
      if (event.altKey && /^[1-5]$/.test(event.key)) {
        event.preventDefault();
        const tabs: Tab[] = ['projects', 'documents', 'simulation', 'settings', 'seat'];
        setTab(tabs[Number(event.key) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (snapshot?.auth.loggedIn)
      void call('notifications.list', {
        limit: 50,
      })
        .then(setNotifications)
        .catch(() => undefined);
  }, [snapshot?.notifications.unread, snapshot?.auth.loggedIn]);
  const openReport = (id: string) => {
    setTab('documents');
    setDocProjectId(null);
    setReportId(id);
  };
  const login = async (dev: boolean): Promise<boolean> => {
    try { await call(dev ? 'auth.devLogin' : 'auth.login'); return true; }
    catch { return false; }
  };
  if (capture === 'poses') return <PoseSheet />;
  if (unauthorized && !snapshot) return <><Login login={login} /><div className="toast-stack login-toasts">{toasts.map(item => <div key={item.id} className={`toast toast-${item.level}`}><strong>{item.title}</strong><p>{item.body}</p><button onClick={() => dismiss(item.id)} aria-label="알림 닫기"><X size={14} /></button></div>)}</div></>;
  if (!snapshot)
    return (
      <><div className="splash">
        &gt;_ <span>욱채를 준비하고 있습니다…</span>
      </div><div className="toast-stack login-toasts">{toasts.map(item => <div key={item.id} className={`toast toast-${item.level}`}><strong>{item.title}</strong><p>{item.body}</p><button onClick={() => dismiss(item.id)} aria-label="알림 닫기"><X size={14} /></button></div>)}</div></>
    );
  if (unauthorized || !snapshot.auth.loggedIn)
    return (
      <>
        <Login login={login} auth={snapshot.auth} />
        <div className="toast-stack login-toasts">
          {toasts.map((item) => (
            <div key={item.id} className={`toast toast-${item.level}`}>
              <strong>{item.title}</strong>
              <p>{item.body}</p>
              <button onClick={() => dismiss(item.id)} aria-label="알림 닫기">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      </>
    );
  const selectedProject = snapshot.projects.find((project) => project.id === projectId);
  const paletteMatches = paletteTargets.filter(([label]) => label.includes(paletteQuery));
  const stop = async () => {
    try {
      const summary = await call('stop.emergency');
      setEmergency(summary);
    } catch {
      /* API 토스트 */
    }
  };
  const release = () => void releaseStop(snapshot);
  const tabSelect = (value: Tab) => {
    setTab(value);
    if (value === 'projects') setProjectId(null);
  };
  return (
    <div className="app-shell seat-layout">
      <header className="topbar">
        <div className="brand">
          <BrandMark />
          <strong>욱채</strong>
          <small>작업실 / 연결됨</small>
        </div>
        <div className="top-actions">
          <SeatChip snapshot={snapshot} open={() => navigate({ tab: 'seat' })} />
          <button className="palette-trigger" onClick={() => { setPaletteQuery(''); setPaletteIndex(0); setPaletteOpen(true); }}><Search size={14} /> 이동 <kbd>Ctrl K</kbd></button>
          <div className="running-indicator">
            <span className="live-dot" />
            <strong>
              실행 {snapshot.running.total}/{snapshot.running.cap}
            </strong>
            <small>대기 {snapshot.running.queued}</small>
          </div>
          <div className="bell-wrap">
            <button className="icon-button bell-button" onClick={() => setBellOpen((value) => !value)} aria-label="알림함">
              <Bell size={20} />
              {snapshot.notifications.unread > 0 && <span className="unread-badge">{snapshot.notifications.unread}</span>}
            </button>
            {bellOpen && (
              <div className="notification-menu">
                <div className="notification-head">
                  <strong>알림함</strong>
                  <button
                    onClick={() =>
                      void call('notifications.markRead', 'all')
                        .then(() => {
                          setNotifications((old) =>
                            old.map((item) => ({
                              ...item,
                              read: true,
                            })),
                          );
                        })
                        .catch(() => undefined)
                    }
                  >
                    <CheckCheck size={15} /> 모두 읽음
                  </button>
                </div>
                {notifications.length ? (
                  notifications.map((item) => (
                    <ServerNotice key={item.id} item={item} snapshot={snapshot} navigate={navigate}
                      showDevices={() => { navigate({ tab: 'settings', section: 'account' }); setDeviceListVisit(Date.now()); }}
                      markRead={() => { void call('notifications.markRead', item.id).catch(() => undefined); }} close={() => setBellOpen(false)} />
                  ))
                ) : (
                  <p className="empty">알림이 없습니다.</p>
                )}
              </div>
            )}
          </div>
          <button className="emergency-button" onClick={() => void stop()}>
            <OctagonAlert size={17} /> 긴급 정지
          </button>
        </div>
      </header>
      <div className="status-stack">
      <SeatUnresponsive snapshot={snapshot} stop={() => void stop()} />
      {snapshot.stop.global.active && (
        <div className="emergency-banner">
          <OctagonAlert size={17} />
          <strong>긴급 정지 중</strong>
          <span>보류된 작업 {snapshot.stop.heldByEmergency}개 · 해제 뒤 메인 에이전트가 확인해 항목별로 재개합니다.</span>
          <button onClick={release}>정지 해제</button>
        </div>
      )}
      <MainPauseNotice snapshot={snapshot} openMember={setMemberId} />
      </div>
      <aside className="sidebar">
        <div className="nav-group">
          <span className="nav-caption">작업 공간</span>
          <button className={`nav-item ${tab === 'projects' ? 'active' : ''}`} title="프로젝트 · Alt 1" onClick={() => tabSelect('projects')}>
            <BriefcaseBusiness size={18} /> 프로젝트
          </button>
          {tab === 'projects' && (
            <div className="project-nav">
              <button className={!projectId ? 'selected' : ''} onClick={() => setProjectId(null)}>
                <HomeNavIcon /> 홈
              </button>
              {snapshot.projects.map((project) => (
                <button className={projectId === project.id ? 'selected' : ''} key={project.id} onClick={() => setProjectId(project.id)}>
                  <span className={`project-dot ${project.paused ? 'dot-paused' : ''}`} />
                  {project.name}
                </button>
              ))}
            </div>
          )}
          <button className={`nav-item ${tab === 'documents' ? 'active' : ''}`} title="문서함 · Alt 2" onClick={() => tabSelect('documents')}>
            <FileText size={18} /> 문서함
          </button>
          <button className={`nav-item ${tab === 'simulation' ? 'active' : ''}`} title="시뮬레이션 · Alt 3" onClick={() => tabSelect('simulation')}>
            <Clapperboard size={18} /> 시뮬레이션
          </button>
          <button className={`nav-item ${tab === 'settings' ? 'active' : ''}`} title="운영 설정 · Alt 4" onClick={() => tabSelect('settings')}>
            <Settings2 size={18} /> 운영 설정
          </button>
        </div>
        <div className="sidebar-footer"><small>사용자 / {snapshot.auth.owner?.name}</small></div>
      </aside>
      <main className="main-content">
        {tab === 'seat' && <SeatScreen snapshot={snapshot} navigate={navigate} />}
        {tab === 'projects' &&
          (selectedProject ? (
            <Studio
              snapshot={snapshot}
              project={selectedProject}
              back={() => setProjectId(null)}
              openMember={setMemberId}
              openTask={setTaskId}
              openDirective={setDirectiveId}
              openReport={openReport}
            />
          ) : (
            <Home
              snapshot={snapshot}
              openProject={setProjectId}
              openTask={setTaskId}
              openReport={openReport}
              openMember={setMemberId}
              openPolicy={() => {
                setTab('settings');
                setSection('policy');
              }}
            />
          ))}
        {tab === 'documents' && (
          <Documents snapshot={snapshot} selectedId={reportId} setSelectedId={setReportId} initialProject={docProjectId} />
        )}
        {tab === 'simulation' && <Simulation projects={snapshot.projects} />}
        {tab === 'settings' && (
          <SettingsBoundary key={section}><SettingsScreen
            snapshot={snapshot}
            section={section}
            setSection={setSection}
            logout={() => void call('auth.logout').catch(() => undefined)}
            openTask={setTaskId}
            deviceListVisit={deviceListVisit}
          /></SettingsBoundary>
        )}
      </main>
      <CommandBar snapshot={snapshot} currentProjectId={tab === 'projects' ? projectId : null} />
      {paletteOpen && (
        <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="command-palette" role="dialog" aria-modal="true" aria-label="빠른 이동" onClick={event => event.stopPropagation()}>
            <div className="palette-input">
              <Search size={18} />
              <input autoFocus role="combobox" aria-controls="palette-options" aria-expanded="true" aria-activedescendant={paletteMatches[paletteIndex] ? `palette-${paletteMatches[paletteIndex][1]}` : undefined} value={paletteQuery} onChange={event => { setPaletteQuery(event.target.value); setPaletteIndex(0); }}
                onKeyDown={event => {
                  if (event.key === 'ArrowDown') { event.preventDefault(); setPaletteIndex(index => Math.min(index + 1, paletteMatches.length - 1)); }
                  if (event.key === 'ArrowUp') { event.preventDefault(); setPaletteIndex(index => Math.max(index - 1, 0)); }
                  if (event.key === 'Enter') {
                    const selected = paletteMatches[paletteIndex];
                    if (selected) { tabSelect(selected[1]); setPaletteOpen(false); }
                  }
                }} placeholder="이동할 화면 검색" />
            </div>
            <div id="palette-options" role="listbox" className="palette-options">
              {paletteMatches.map(([label, value], index) => (
                <button key={value} id={`palette-${value}`} role="option" aria-selected={index === paletteIndex} className={index === paletteIndex ? 'palette-selected' : ''} onMouseEnter={() => setPaletteIndex(index)} onClick={() => { tabSelect(value); setPaletteOpen(false); }}>
                  <span>{label}</span><kbd>Alt {paletteTargets.findIndex(([, target]) => target === value) + 1}</kbd>
                </button>
              ))}
            </div>
            <small>Enter 선택 · Esc 닫기</small>
          </div>
        </div>
      )}
      {memberId && <MemberPanel key={memberId} id={memberId} snapshot={snapshot} close={() => setMemberId(null)} openTask={setTaskId} />}
      {taskId && <TaskDetail id={taskId} snapshot={snapshot} close={() => setTaskId(null)} openDirective={setDirectiveId} openTask={setTaskId} />}
      {directiveId && <DirectiveDetail id={directiveId} snapshot={snapshot} close={() => setDirectiveId(null)} openTask={setTaskId} openReport={openReport} />}
      {emergency && <EmergencyModal summary={emergency} snapshot={snapshot} close={() => setEmergency(null)} openTask={setTaskId} />}
      <div className="toast-stack">
        {toasts.map((item) => (
          <div key={item.id} className={`toast toast-${item.level}`}>
            <strong>{item.title}</strong><p>{item.body}</p>
            <button onClick={() => dismiss(item.id)} aria-label="알림 닫기"><X size={14} /></button>
          </div>
        ))}
      </div>
    </div>
  );
}
