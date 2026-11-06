import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Reintroduce one product defect at a time; always restore the original bytes.
const wrapper = 'C:/Users/pc_09/AppData/Local/Temp/claude/C--WOOK-wookagent/7f7656cb-51f2-4626-b0fb-713c3230d9b4/scratchpad/vt.sh';
const tests = 'src/renderer/src/components/web-stage8.test.ts';
const baseline = spawnSync('bash', [wrapper, '--config', 'src/renderer/tools/vitest.config.ts', tests], { encoding: 'utf8', windowsHide: true });
if (baseline.status !== 0) { console.error(baseline.stdout, baseline.stderr); throw new Error('Baseline failed; no mutation was applied'); }
const mutations = [
  ['web-path', 'lib/uploads.ts', 'return { name: item.name, uploadId: item.state.uploadId };', "return { name: item.name, path: 'C:/server/file' };", 'S8-upload-wire'],
  ['upload-error-hidden', 'components/CommandBar.tsx', '<small role="alert">{item.state.message}</small>', '<small role="alert"> </small>', 'S8-upload-error'],
  ['download-link-missing', 'components/FileDownload.tsx', 'href={url}', '', 'S8-download'],
  ['web-openPath', 'components/FileDownload.tsx', 'if (runtime().web)', 'if (false)', 'S8-download'],
  ['installation-visible', 'api/runtime.ts', 'desktop: !web && !server', 'desktop: true', 'S8-hidden'],
  ['reconnect-indicator-missing', 'components/ConnectionStatus.tsx', 'if (!web) return null;', "if (!web || state.status === 'reconnecting') return null;", 'S8-connection'],
  ['duplicate-resync', 'lib/memberEvents.ts', '[...unique.values()].sort', '[...previous, ...incoming].sort', 'S8-resync'],
  ['history-first-page-oldest', 'components/MemberPanel.tsx', 'events.slice(-visibleCount)', 'events.slice(0, visibleCount)', 'S8-member-panel'],
  ['visible-page-notification', 'lib/browserNotifications.ts', "document.visibilityState !== 'hidden'", 'false', 'S8-notification:'],
  ['ungranted-notification', 'lib/browserNotifications.ts', "Notification.permission !== 'granted'", 'false', 'S8-notification:'],
  ['automatic-permission', 'components/NotificationOffer.tsx', 'Notification.permission);', '(Notification.requestPermission(), Notification.permission));', 'S8-notification-offer'],
  ['login409-stuck', 'components/ServerLogin.tsx', 'setSetup(true); return;', 'setSetup(false); return;', 'S8-login409'],
  ['raw-dev-flag', 'studio3d/Studio3D.tsx', "devParam('officeDemo')", "new URLSearchParams(window.location.search).get('officeDemo')", 'S8-flags-and-imports'],
  ['studio-fake-import', 'studio3d/behaviour.ts', "'../studio/officeDemoStep'", "'../api/fake/officeDemo'", 'S8-flags-and-imports'],
  ['watch-missing', 'components/MemberPanel.tsx', 'await web.watchMembers([id]);', 'await web.watchMembers([]);', 'S8-member-panel'],
  ['backfill-missing', 'components/MemberPanel.tsx', 'void refresh(String(maxSeq));', 'void maxSeq;', 'S8-member-panel'],
  ['notification-resync-missing', 'App.tsx', "void call('notifications.list', { limit: 50 }).then(updateNotifications)", "void Promise.resolve([]).then(updateNotifications)", 'S8-app-resync'],
  ['fake-upload-failure-missing', 'api/fake/web.ts', "devParam('fakeUpload') === 'fail' && !failures.has(name)", 'false', 'S8-fake-web'],
  ['fake-upload-progress-missing', 'api/fake/web.ts', 'options?.onProgress?.(sent, file.size);', '', 'S8-fake-web'],
  ['paste-upload-missing', 'components/CommandBar.tsx', "addFiles(images.flatMap(item => { const file = item.getAsFile(); return file ? [file] : []; }));", 'queue.current?.add([]);', 'S8-upload-wire'],
  ['four-concurrent-uploads', 'lib/uploads.ts', 'if (this.active.size >= 3) break;', 'if (this.active.size >= 4) break;', 'S8-upload-limits'],
  ['oversize-file-queued', 'lib/uploads.ts', 'file.size > MAX_UPLOAD_BYTES', 'false && file.size > MAX_UPLOAD_BYTES', 'S8-upload-limits'],
  ['seat-history-every-snapshot', 'screens/Seat.tsx', '[snapshot.seat.generation, snapshot.seat.state, snapshot.seat.unresponsiveSince]', '[snapshot.seat]', 'S8-seat'],
  ['watch-not-awaited', 'components/MemberPanel.tsx', 'await web.watchMembers([id]);', 'void web.watchMembers([id]);', 'S8-panel-watch-gap'],
  ['watch-catchup-missing', 'components/MemberPanel.tsx', 'if (active) await refresh(String(maxSeq ?? 0));', 'if (active) void maxSeq;', 'S8-panel-watch-gap'],
  ['watch-live-suffix-skips-gap', 'components/MemberPanel.tsx', 'const maxSeq = await initial;', 'await initial; const maxSeq = Math.max(0, ...currentEvents.map(event => event.seq));', 'S8-panel-watch-gap'],
  ['live-dedupe-missing', 'components/MemberPanel.tsx', 'if (payload.turnId === turnId) merge(payload.events);', 'if (payload.turnId === turnId) { currentEvents = [...currentEvents, ...payload.events]; setEvents(currentEvents); }', 'S8-member-panel'],
  ['rate-limit-error-immediate', 'lib/uploads.ts', "error.code === 'rate_limited' && retry < 3", "error.code === 'rate_limited' && retry < 0", 'S8-upload-rate-limit:'],
  ['rate-limit-no-backoff', 'lib/uploads.ts', 'const delay = retry === 0 ? 300 : retry === 1 ? 1000 : retryAfter;', 'const delay = 0;', 'S8-upload-rate-limit:'],
  ['rate-limit-retry-forever', 'lib/uploads.ts', "error.code === 'rate_limited' && retry < 3", "error.code === 'rate_limited' && retry < 30", 'S8-upload-rate-exhausted'],
  ['rate-limit-ignore-retry-after', 'lib/uploads.ts', 'retry === 1 ? 1000 : retryAfter', 'retry === 1 ? 1000 : 5000', 'S8-upload-rate-exhausted'],
  ['retry-never-starts', 'lib/uploads.ts', 'this.publish(); this.pump();\n  }\n  clear()', 'this.publish();\n  }\n  clear()', 'S8-upload-error'],
  ['upload-unauthorized-ignored', 'lib/uploads.ts', "if (error.code === 'unauthorized') window.dispatchEvent(new Event('wook:unauthorized'));", '', 'S8-upload-unauthorized'],
  ['notification-no-worker', 'lib/browserNotifications.ts', 'if (registration) {', 'if (false) {', 'S8-notification-worker'],
  ['notification-server-title', 'lib/browserNotifications.ts', 'registration.showNotification(NOTIFICATION_TITLE,', 'registration.showNotification(item.title,', 'S8-notification-worker'],
  ['notification-server-body', 'lib/browserNotifications.ts', '{ body, tag, data: { link } }', '{ body: item.body, tag, data: { link } }', 'S8-notification-worker'],
  ['notification-no-tag', 'lib/browserNotifications.ts', '{ body, tag, data: { link } }', '{ body, data: { link } }', 'S8-notification-worker'],
  ['notification-failure-silent', 'lib/browserNotifications.ts', 'catch { cannotShow(); }', 'catch {}', 'S8-notification-unavailable'],
  ['notification-no-navigate', 'lib/browserNotifications.ts', "navigator.serviceWorker?.addEventListener('message', receive);", '', 'S8-notification-worker'],
  ['worker-no-focus', 'public/notify-sw.js', 'await client.focus();', '', 'S8-worker-click'],
  ['worker-no-open-window', 'public/notify-sw.js', 'else await self.clients.openWindow(link);', 'else void link;', 'S8-worker-click'],
  ['worker-foreign-link', 'public/notify-sw.js', "if (typeof link !== 'string' || !link.startsWith('/') || link.startsWith('//') || link.includes('\\\\')) return;\n  const target = new URL(link, self.location.origin);\n  if (target.origin !== self.location.origin) return;", "if (typeof link !== 'string') return;", 'S8-worker-click'],
  ['worker-fetch-handler', 'public/notify-sw.js', "self.addEventListener('notificationclick',", "self.addEventListener('fetch', () => {});\nself.addEventListener('notificationclick',", 'S8-worker-click'],
  ['directive-duplicate-attachments', 'components/TaskDetail.tsx', '</Section>}<Progress value={d.progress}', '</Section>}{d.attachments.length > 0 && <Section title="첨부 파일">{d.attachments.map(file => <FileDownload key={file.id} target={{ kind: \'attachment\', id: file.id }} path={file.path}>{file.name}</FileDownload>)}</Section>}<Progress value={d.progress}', 'S8-directive-and-text'],
  ['korean-replacement-character', 'components/ConnectionStatus.tsx', '서버 연결 상태', '\uFFFD', 'S8-directive-and-text'],
  ['korean-question-marks', 'components/ConnectionStatus.tsx', '서버 연결 상태', '?'.repeat(2), 'S8-directive-and-text'],
  ['missed-notifications-not-shown', 'App.tsx', 'if (runtime().web) void showMissedNotifications(items, navigate);', '', 'S8-app-resync'],
  ['missed-notifications-include-old', 'lib/browserNotifications.ts', '!item.read && !current.seen.has(item.id)', '!item.read', 'S8-missed-notifications'],
  ['missed-notifications-include-read', 'lib/browserNotifications.ts', '!item.read && !current.seen.has(item.id)', '!current.seen.has(item.id)', 'S8-missed-notifications'],
  ['project-conversation-not-selected', 'screens/Documents.tsx', 'openConversation(detail.projectId);', '', 'S8-project-changes'],
  ['project-conversation-not-explained', 'screens/Documents.tsx', '${detail.projectName} 대화에 수정 요청을 표시했습니다.', '수정 요청을 보냈습니다.', 'S8-project-changes'],
  ['login409-generic-toast', 'components/ServerLogin.tsx', "await getBridge().invoke('auth.deviceLogin',", "await call('auth.deviceLogin',", 'S8-login409'],
  ['home-path-no-wrap', 'styles/web.css', '.web-layout .project-path { min-width: 0; overflow-wrap: anywhere; white-space: normal; }', '.web-layout .project-path { min-width: 0; overflow-wrap: normal; white-space: nowrap; }', 'S8-home-wrap'],
  ['home-card-no-shrink', 'styles/web.css', '.web-layout .project-card { min-width: 0; }', '.web-layout .project-card { min-width: auto; }', 'S8-home-wrap'],
  ['desktop-download-wording', 'screens/Settings.tsx', ": '내보낸 기록 열기'", ": '내보낸 기록 내려받기'", 'S8-desktop-export'],
  ['web-escape-ignored', 'App.tsx', "if (event.key === 'Escape') setPaletteOpen(false);", "if (!runtime().web && event.key === 'Escape') setPaletteOpen(false);", 'S8-web-escape'],
  ['fake-change-message-missing', 'api/fake/index.ts', "text: `보고서 ${id} \"${item.title}\" 수정 요청:\\n${detail}`.slice(0, 20000)", "text: ''", 'S8-fake-changes'],
  ['fake-watch-not-promise', 'api/fake/web.ts', 'async watchMembers(ids) { watched.clear(); for (const id of ids) { if (watched.size >= 50) break; watched.add(id); } await Promise.resolve(); }', 'watchMembers(ids) { watched.clear(); for (const id of ids) { if (watched.size >= 50) break; watched.add(id); } }', 'S8-fake-web'],
  ['notification-no-granted-registration', 'components/NotificationOffer.tsx', "if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void prepareBrowserNotifications();", '', 'S8-notification-granted-load'],
  ['doc-typecheck-stale', 'docs/design/permission-ui/stage8-web/README.md', '| `npx tsc --noEmit -p tsconfig.web.json` | **exit 0**', '| `npx tsc --noEmit -p tsconfig.web.json` | **exit 1**', 'S8-doc-status'],
  ['missed-clock-skew', 'lib/browserNotifications.ts', '!item.read && !current.seen.has(item.id)', '!item.read && !current.seen.has(item.id) && Date.parse(item.createdAt) > Date.now()', 'S8-clock-skew'],
  ['missed-silent-dead-clock', 'lib/browserNotifications.ts', '!item.read && !current.seen.has(item.id)', '!item.read && !current.seen.has(item.id) && Date.parse(item.createdAt) > Date.now()', 'S8-silent-dead'],
  ['missed-later-list-ignored', 'App.tsx', '.then(updateNotifications)\n', '.then(setNotifications)\n', 'S8-later-list'],
  ['missed-live-not-seen', 'lib/browserNotifications.ts', 'state().seen.add(item.id);', '', 'S8-live-before-list'],
  ['missed-first-list-announced', 'lib/browserNotifications.ts', 'current.listed ? items.filter', 'true ? items.filter', 'S8-missed-notifications'],
  ['watch-empty-no-catchup', 'components/MemberPanel.tsx', 'if (active) await refresh(String(maxSeq ?? 0));', 'if (active && maxSeq) await refresh(String(maxSeq));', 'S8-panel-empty-catchup'],
  ['worker-controlled-only', 'public/notify-sw.js', '{ type: \'window\', includeUncontrolled: true }', '{ type: \'window\' }', 'S8-worker-click'],
  ['worker-reject-no-fallback', 'lib/browserNotifications.ts', 'catch { /* Try the constructor below. */ }', 'catch (error) { throw error; }', 'S8-worker-reject-fallback'],
  ['registration-no-recheck', 'lib/browserNotifications.ts', "if (Notification.permission !== 'granted' || document.visibilityState !== 'hidden') return;", '', 'S8-registration-recheck'],
  ['notice-dismiss-ignored', 'components/NotificationOffer.tsx', 'setNoticeDismissed(true);', '', 'S8-notice-viewer'],
  ['notice-dismiss-not-stored', 'components/NotificationOffer.tsx', "window.localStorage.setItem(dismissalKey(viewer), '1');", '', 'S8-notice-viewer'],
  ['notice-dismiss-not-read', 'components/NotificationOffer.tsx', "window.localStorage.getItem(dismissalKey(viewer)) === '1'", 'false', 'S8-notice-viewer'],
  ['notice-shared-viewer', 'components/NotificationOffer.tsx', 'encodeURIComponent(viewer)', "'all-viewers'", 'S8-notice-viewer'],
  ['notice-every-screen', 'App.tsx', "visible={tab === 'projects' && !projectId}", 'visible={true}', 'S8-notice-home'],
  ['notice-storage-exception-hides', 'components/NotificationOffer.tsx', 'catch { return false; }', 'catch { return true; }', 'S8-notice-storage-blocked'],
];
const results = [];
const requested = new Set(process.argv.slice(2));
const selected = requested.size ? mutations.filter(([name]) => requested.has(name)) : mutations;
if (!selected.length) throw new Error('No matching mutations');
for (const [name, file, before, after, test] of selected) {
  const path = file.startsWith('public/') ? resolve('src/renderer', file) : file.startsWith('docs/') ? resolve(file) : resolve('src/renderer/src', file), bytes = readFileSync(path), original = bytes.toString('utf8');
  if (!original.includes(before)) throw new Error(`Mutation anchor missing: ${name}`);
  let result;
  try {
    writeFileSync(path, original.replaceAll(before, after));
    result = spawnSync('bash', [wrapper, '--config', 'src/renderer/tools/vitest.config.ts', tests, '-t', test], { encoding: 'utf8', windowsHide: true });
  } finally { writeFileSync(path, bytes); if (!readFileSync(path).equals(bytes)) throw new Error(`Restore failed: ${name}`); }
  const output = `${result.stdout}\n${result.stderr}`;
  const caught = result.status !== 0 && /AssertionError/.test(output);
  results.push({ name, file, test, caught, exitCode: result.status });
  console.log(`${name}: ${caught ? 'caught by assertion' : 'NOT caught'}`);
  if (!caught) { console.error(output); break; }
}
const output = resolve('docs/design/permission-ui/stage8-web');
mkdirSync(output, { recursive: true });
const path = resolve(output, 'mutation-results.json');
const previous = requested.size ? JSON.parse(readFileSync(path, 'utf8')) : [];
const combined = requested.size ? mutations.map(([name]) => results.find(item => item.name === name) ?? previous.find(item => item.name === name)).filter(Boolean) : results;
writeFileSync(path, JSON.stringify(combined, null, 2) + '\n');
if (results.length !== selected.length || results.some(result => !result.caught)) process.exitCode = 1;
