import { useEffect, useState, type FormEvent } from 'react';
import { ArrowUpRight, Check, Copy, KeyRound, MonitorSmartphone, ShieldCheck } from 'lucide-react';
import type { AuthState, DeviceLoginStart } from '../../../shared/views';
import { call } from '../api/store';
import { getBridge } from '../api/bridge';

export function browserDeviceName(userAgent = navigator.userAgent): string {
  if (/Android/i.test(userAgent)) return '휴대폰 (Android)';
  if (/iPhone/i.test(userAgent)) return '휴대폰 (iPhone)';
  if (/iPad/i.test(userAgent)) return '태블릿 (iPad)';
  if (/Windows/i.test(userAgent)) return 'PC (Windows)';
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'PC (Mac)';
  if (/Linux/i.test(userAgent)) return 'PC (Linux)';
  return '웹 브라우저';
}

type LoginStep = { kind: 'idle' } | { kind: 'starting' } |
  { kind: 'waiting'; start: DeviceLoginStart } | { kind: 'failed'; message: string };
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

function ServerFrame({ children }: { children: React.ReactNode }) {
  return <main className="server-login-screen">
    <header className="server-login-brand"><span className="server-brand-mark">욱</span><strong>욱채</strong><span>나의 작업실</span></header>
    <section className="server-login-card">{children}</section>
    <footer><ShieldCheck size={16} aria-hidden="true" /> Tailscale로 연결한 나의 서버</footer>
  </main>;
}

export function OwnerSetup({ onSetup }: { onSetup: (auth: AuthState) => void }) {
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true); setMessage('');
    try { onSetup(await call('auth.setupOwner', code.trim(), email.trim())); }
    catch (error) { setMessage(errorMessage(error, '설정을 저장하지 못했습니다. 잠시 뒤 다시 시도해 주세요.')); }
    finally { setSaving(false); }
  };
  return <ServerFrame>
    <span className="server-login-icon"><KeyRound size={25} aria-hidden="true" /></span>
    <h1>서버 설정이 끝나지 않았습니다</h1>
    <form className="owner-setup-form" onSubmit={event => void submit(event)}>
      <label htmlFor="owner-setup-code">설정 코드<input id="owner-setup-code" value={code} onChange={event => setCode(event.target.value.toUpperCase())}
        minLength={8} maxLength={8} pattern="[A-Za-z0-9]{8}" required autoCapitalize="characters" autoComplete="off" spellCheck={false} placeholder="8자리 코드" aria-describedby="setup-code-source" /></label>
      <p className="muted setup-code-source" id="setup-code-source">서버를 처음 켤 때 서버 PC의 콘솔과 setup-code.txt에 나온 코드입니다</p>
      <label htmlFor="owner-setup-email">대표 이메일<input id="owner-setup-email" type="email" value={email} onChange={event => setEmail(event.target.value)} required autoComplete="email" placeholder="Google 계정 이메일" /></label>
      {message && <p className="server-login-error" role="alert">{message}</p>}
      <button className="primary-button" type="submit" disabled={saving || code.trim().length !== 8 || !email.trim()}>{saving ? '저장 중…' : '대표 이메일 등록'}</button>
    </form>
  </ServerFrame>;
}

export function ServerLogin() {
  const [setup, setSetup] = useState(false);
  const [step, setStep] = useState<LoginStep>({ kind: 'idle' });
  const [now, setNow] = useState(Date.now());
  const [copyMessage, setCopyMessage] = useState('');
  const start = async () => {
    setStep({ kind: 'starting' }); setCopyMessage('');
    try { setStep({ kind: 'waiting', start: await getBridge().invoke('auth.deviceLogin', browserDeviceName()) }); setNow(Date.now()); }
    catch (error) {
      try { const auth = await call('auth.getState'); if (auth.setupRequired) { setSetup(true); return; } } catch { /* 원래 로그인 오류를 표시한다. */ }
      setStep({ kind: 'failed', message: errorMessage(error, '로그인을 시작하지 못했습니다. 잠시 뒤 다시 시도해 주세요.') });
    }
  };
  useEffect(() => {
    if (step.kind !== 'waiting') return;
    const { start } = step;
    let cancelled = false;
    let intervalSec = start.intervalSec;
    let pollTimer: ReturnType<typeof setTimeout>;
    const expire = () => setStep({ kind: 'failed', message: '로그인 코드가 만료되었습니다. 다시 시작해 주세요.' });
    const poll = async () => {
      if (Date.now() >= Date.parse(start.expiresAt)) { expire(); return; }
      try {
        const result = await call('auth.deviceLoginPoll', start.loginId);
        if (cancelled) return;
        if (result.status === 'ok') {
          const auth = await call('auth.getState');
          if (cancelled) return;
          if (auth.loggedIn) window.dispatchEvent(new Event('wook:authorized'));
          else setStep({ kind: 'failed', message: '로그인 상태를 확인하지 못했습니다. 다시 시작해 주세요.' });
        } else if (result.status === 'pending') {
          if (result.intervalSec !== undefined && result.intervalSec >= 1 && result.intervalSec <= 60) {
            intervalSec = result.intervalSec;
          }
          pollTimer = setTimeout(() => void poll(), intervalSec * 1000);
        } else {
          const fallback = { denied: '로그인이 거절되었습니다. 대표 Google 계정인지 확인해 주세요.', expired: '로그인 코드가 만료되었습니다. 다시 시작해 주세요.', error: '로그인 중 오류가 발생했습니다. 다시 시작해 주세요.' };
          setStep({ kind: 'failed', message: result.message ?? fallback[result.status] });
        }
      } catch (error) {
        if (!cancelled) setStep({ kind: 'failed', message: errorMessage(error, '로그인 상태를 확인하지 못했습니다. 다시 시작해 주세요.') });
      }
    };
    pollTimer = setTimeout(() => void poll(), start.intervalSec * 1000);
    const clock = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= Date.parse(start.expiresAt)) expire();
    }, 1000);
    return () => { cancelled = true; clearTimeout(pollTimer); clearInterval(clock); };
  }, [step]);
  const copy = async (code: string) => {
    try { await navigator.clipboard.writeText(code); setCopyMessage('코드를 복사했습니다'); }
    catch { setCopyMessage('복사하지 못했습니다. 위 코드를 직접 입력해 주세요.'); }
  };
  const remaining = step.kind === 'waiting' ? Math.max(0, Math.ceil((Date.parse(step.start.expiresAt) - now) / 1000)) : 0;
  if (setup) return <OwnerSetup onSetup={auth => { setSetup(!!auth.setupRequired); setStep({ kind: 'idle' }); }} />;
  return <ServerFrame>
    <span className="server-login-icon"><MonitorSmartphone size={26} aria-hidden="true" /></span>
    <span className="eyebrow">내 서버에 로그인</span>
    <h1>{step.kind === 'waiting' ? 'Google에 이 코드를 입력하세요' : step.kind === 'failed' ? '로그인을 마치지 못했습니다' : '어디서든, 나의 작업실로'}</h1>
    {step.kind === 'waiting' ? <>
      <p className="server-login-description">아래 주소를 열고 대표 Google 계정으로 로그인해 주세요. 로그인을 마치면 작업실로 이동합니다.</p>
      <div className="device-code-box"><span>로그인 코드</span><strong className="device-user-code">{step.start.userCode}</strong>
        <button onClick={() => void copy(step.start.userCode)}><Copy size={16} aria-hidden="true" /> 코드 복사</button></div>
      <p className="device-code-warning">이 코드는 지금 이 화면에서 시작한 로그인입니다. 다른 사람이 보내 준 코드는 넣지 마세요.</p>
      <a className="primary-button device-verification-link" href={step.start.verificationUrl} target="_blank" rel="noopener noreferrer">google.com/device 열기 <ArrowUpRight size={17} aria-hidden="true" /></a>
      <p className="device-login-time">남은 시간 <strong>{Math.floor(remaining / 60)}분 {String(remaining % 60).padStart(2, '0')}초</strong><span>Google 로그인 확인 중…</span></p>
      {copyMessage && <p className="copy-status" role="status"><Check size={15} aria-hidden="true" />{copyMessage}</p>}
    </> : step.kind === 'failed' ? <>
      <p className="server-login-error" role="alert">{step.message}</p>
      <button className="primary-button server-login-start" onClick={() => void start()}>다시 시작</button>
    </> : <>
      <p className="server-login-description">Google 계정으로 로그인하고<br />프로젝트와 팀의 작업을 이어서 확인하세요.</p>
      <button className="primary-button server-login-start" disabled={step.kind === 'starting'} onClick={() => void start()}>{step.kind === 'starting' ? '코드를 준비하고 있습니다…' : 'Google 계정으로 로그인'}</button>
    </>}
  </ServerFrame>;
}
