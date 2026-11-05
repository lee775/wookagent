/**
 * 설정 코드의 모든 꼴을 가린다 (SERVER_DESIGN 3.5, 리드 결정 S3-18 — 검토 프로브 zz-s3sec-setupcode·zz-s3ti-setup-code-display를 옮김).
 * 서버는 코드를 'ABCD-EFGH'로 보여 주고(콘솔·setup-code.txt) auth.setupOwner는 대소문자·줄표·띄어쓰기를 가리지 않는다. 받는 꼴은 모두 백엔드 가리개와
 * 서버 기록 가리기에서 가려져야 한다 — 받는 꼴과 가리는 꼴은 serverLogin.ts의 한 정의(normalizeSetupCode·setupCodePattern)에서 나온다.
 * 받는 꼴은 ASCII만이다 (S3-33 — 둘째 검토 프로브 zz-s3ss-setupcode-unicode를 옮김): 유니코드 대소문자 바꾸기('ſ'→S, 'ﬀ'→FF, 'ﬅ'·'ﬆ'→ST, 'ß'→SS)와
 * 전각 글자, 공백·줄표 밖의 구분 글자로 쓴 코드는 받지 않는다 — 받지 않는 꼴의 목록이 있어 받는 꼴이 넓어지면 시험이 깨진다.
 * 코드 값은 시험 출력에 내지 않는다 — 참거짓으로만 본다
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedactor } from '../../src/core/redact';
import { createBackendOperator } from '../../src/main/backend/operator';
import { normalizeSetupCode, SetupCodes, setupCodePattern, showSetupCode } from '../../src/main/orchestrator/serverLogin';
import { serverRedactor } from '../../src/server/serve';
import { invokeHttp } from './helpers';
import { ownerServer, type OwnerServer } from './ownerServer';

/** 사람이 코드를 옮겨 적는 꼴들 — 받는 것과 받지 않는 것이 섞여 있다 (받지 않는 꼴은 가리지 않아도 된다) */
const FORMS: [name: string, form: (code: string) => string][] = [
  ['원문', (c) => c],
  ['보이는 꼴', (c) => showSetupCode(c)],
  ['소문자', (c) => c.toLowerCase()],
  ['소문자 보이는 꼴', (c) => showSetupCode(c).toLowerCase()],
  ['섞인 대소문자', (c) => `${c.slice(0, 4).toLowerCase()}-${c.slice(4)}`],
  ['띄어쓰기', (c) => `${c.slice(0, 4)} ${c.slice(4)}`],
  ['소문자 띄어쓰기', (c) => `${c.slice(0, 4)} ${c.slice(4)}`.toLowerCase()],
  ['앞뒤 공백', (c) => ` ${showSetupCode(c)} `],
  ['두 글자씩', (c) => c.match(/../g)!.join('-')],
  ['줄표 앞뒤 공백', (c) => `${c.slice(0, 4)} - ${c.slice(4)}`],
  ['탭', (c) => `${c.slice(0, 4)}\t${c.slice(4)}`],
  // 지금은 받지 않는 꼴 — 받는 꼴이 넓어지면(정의가 어긋나면) 가리는 꼴도 따라가야 한다
  ['밑줄', (c) => `${c.slice(0, 4)}_${c.slice(4)}`],
  ['점', (c) => `${c.slice(0, 4)}.${c.slice(4)}`],
  ['긴 줄표', (c) => `${c.slice(0, 4)}–${c.slice(4)}`],
];

/** 가린 글에 코드가 남았는지 — 구분 글자를 빼고 대문자로 바꿔도 코드 글자들이 이어져 나오지 않아야 한다 */
const leaks = (out: string, code: string): boolean => out.toUpperCase().replace(/[\s\-_.–]/g, '').includes(code);

/**
 * 받지 않는 꼴 (S3-33): [이름, 그 꼴을 만들 수 있는 코드, 꼴]. 유니코드 대소문자 바꾸기는 toUpperCase로 코드 글자가 되지만 가리는 꼴(ASCII 대소문자만 무시)에
 * 걸리지 않는다 — 받으면 원문으로 저장되는 살아 있는 코드가 생긴다
 */
const NOT_ACCEPTED: [name: string, needs: RegExp, form: (code: string) => string][] = [
  ['긴 s (ſ, U+017F)', /S/, (c) => c.replace('S', 'ſ')],
  ['긴 s와 소문자', /S/, (c) => c.replace('S', 'ſ').toLowerCase()],
  ['합자 ﬀ', /FF/, (c) => c.replace('FF', 'ﬀ')],
  ['합자 ﬅ', /ST/, (c) => c.replace('ST', 'ﬅ')],
  ['합자 ﬆ', /ST/, (c) => c.replace('ST', 'ﬆ')],
  ['에스체트 ß', /SS/, (c) => c.replace('SS', 'ß')],
  ['전각 글자 하나', /^/, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0) + c.slice(1)],
  ['전각 보이는 꼴', /^/, (c) => [...showSetupCode(c)].map((x) => String.fromCharCode(x.charCodeAt(0) + 0xfee0)).join('')],
  ['탭', /^/, (c) => `${c.slice(0, 4)}\t${c.slice(4)}`],
  ['줄 바꿈', /^/, (c) => `${c.slice(0, 4)}\n${c.slice(4)}`],
  ['밑줄', /^/, (c) => `${c.slice(0, 4)}_${c.slice(4)}`],
  ['점', /^/, (c) => `${c.slice(0, 4)}.${c.slice(4)}`],
  ['긴 줄표', /^/, (c) => `${c.slice(0, 4)}–${c.slice(4)}`],
];

/** 그 모양을 가진 코드가 나올 때까지 새 코드 (FF·SS는 100개에 하나쯤) */
function issueMatching(needs: RegExp): { codes: SetupCodes; code: string } {
  for (let i = 0; i < 100_000; i++) {
    const codes = new SetupCodes(() => 1_000_000);
    const { code } = codes.issue();
    if (needs.test(code)) return { codes, code };
  }
  throw new Error(`그 모양의 코드를 만들지 못했습니다: ${needs}`);
}

describe('설정 코드의 받는 꼴과 가리는 꼴 (S3-18)', () => {
  it('auth.setupOwner가 받는 꼴은 모두 백엔드 가리개와 서버 기록 가리기에서 가려진다 — 결정이 말한 꼴(원문·ABCD-EFGH·소문자·띄어쓰기)은 받는다', () => {
    const accepted: string[] = [];
    const notHidden: string[] = [];
    for (const [name, form] of FORMS) {
      // 꼴마다 새 코드 — 맞는 코드는 한 번만 쓰인다
      const codes = new SetupCodes(() => 1_000_000);
      const { code } = codes.issue();
      const backend = createRedactor();
      backend.addSecret(code, 'setup-code');
      backend.addPattern(setupCodePattern(code), 'setup-code');
      const serverLog = serverRedactor(() => null, new Set([code]));
      const input = form(code);
      if (!codes.check(input).ok) continue;
      accepted.push(name);
      const line = `서버 콘솔에 나온 코드 ${input}를 넣었습니다`;
      if (leaks(backend.text(line), code)) notHidden.push(`${name} (백엔드)`);
      if (leaks(serverLog(line), code)) notHidden.push(`${name} (서버 기록)`);
    }
    expect(accepted).toEqual(expect.arrayContaining(['원문', '보이는 꼴', '소문자', '소문자 보이는 꼴', '섞인 대소문자', '띄어쓰기', '소문자 띄어쓰기', '앞뒤 공백']));
    expect(notHidden).toEqual([]);
  });

  it('ASCII만 받는다 — 유니코드 대소문자 바꾸기(ſ·ﬀ·ﬅ·ﬆ·ß)·전각 글자·공백과 줄표 밖의 구분 글자로 쓴 코드는 받지 않고 틀린 것으로 센다 (S3-33)', () => {
    const accepted: string[] = [];
    for (const [name, needs, form] of NOT_ACCEPTED) {
      const { codes, code } = issueMatching(needs);
      const input = form(code);
      expect(input === code, name).toBe(false);
      if (normalizeSetupCode(input) !== null) accepted.push(`${name} (다듬기)`);
      const check = codes.check(input);
      if (check.ok) {
        accepted.push(`${name} (확인)`);
        continue;
      }
      expect([check.reason, check.left], name).toEqual(['wrong', 4]);
      // 받지 않은 꼴은 그 코드를 쓰지 않았다 — 원래 코드는 그대로 받는다
      expect(codes.check(code).ok, name).toBe(true);
    }
    expect(accepted).toEqual([]);
    // 받는 꼴의 다듬기는 a-z만 대문자로 바꾸고 띄어쓰기·줄표만 뺀다
    expect([normalizeSetupCode('abcd-efgh'), normalizeSetupCode(' AB CD-ef gh '), normalizeSetupCode('ABCD-EFGſ'), normalizeSetupCode('ABCD\tEFGH')]).toEqual(['ABCDEFGH', 'ABCDEFGH', null, null]);
  });

  it('다른 코드와 보통 글은 가리지 않는다 — 한 글자만 달라도, 영숫자에 붙은 글자열도', () => {
    const codes = new SetupCodes(() => 1_000_000);
    const { code } = codes.issue();
    const r = createRedactor();
    r.addPattern(setupCodePattern(code), 'setup-code');
    const other = `${code.slice(0, 7)}${code[7] === 'A' ? 'B' : 'A'}`;
    const texts = [`다른 코드 ${showSetupCode(other)}`, `붙은 글자 X${code}`, `${code}9 뒤에 붙음`, '설정 코드를 넣으세요'];
    expect(texts.map((t) => r.text(t) === t)).toEqual([true, true, true, true]);
    // 가린 표시는 다시 가려도 그대로다
    const once = r.text(`코드 ${showSetupCode(code)}`);
    expect([once.includes('[가림:setup-code]'), r.text(once) === once]).toEqual([true, true]);
  });
});

describe('서버가 낸 설정 코드를 명령에 붙여 넣어도 저장되지 않는다 (S3-18, 프로브 zz-s3sec-setupcode)', () => {
  let o: OwnerServer;
  beforeAll(async () => {
    o = await ownerServer();
  }, 120_000);
  afterAll(async () => {
    await o?.close();
  });

  it("'ſ'로 쓴 코드는 auth.setupOwner가 받지 않는다 — 틀린 것으로 세고 대표 이메일은 그대로, 원래 코드는 그 뒤에도 살아 있다 (S3-33, 프로브 zz-s3ss-setupcode-unicode)", async () => {
    const op = createBackendOperator(() => o.h.core);
    let raw = '';
    for (let i = 0; i < 300 && !raw.includes('S'); i++) raw = op.issueSetupCode()!.code;
    expect(raw.includes('S')).toBe(true);
    const odd = raw.replace('S', 'ſ').toLowerCase();
    const r = await invokeHttp(o.server.url, null, 'auth.setupOwner', [odd, 'owner@example.com']);
    expect([r.status, r.json<{ error?: { code: string; message: string } }>().error]).toEqual([
      400,
      { code: 'invalid', message: '설정 코드가 맞지 않습니다 — 서버 PC의 콘솔이나 setup-code.txt에 나온 코드를 넣으세요 (이 코드로 4번 더 해 볼 수 있습니다)' },
    ]);
    expect(o.h.core.serverLogin.ownerEmail()).toBeNull();
    expect(o.h.core.serverLogin.setupCodes.activeUntil()).not.toBeNull();
  });

  it('보이는 꼴(ABCD-EFGH)·소문자·띄어쓰기로 붙인 코드는 대화·활동 기록에 없고, 그 꼴로도 대표 이메일을 정할 수 있었다(살아 있는 코드였다)', async () => {
    const grant = createBackendOperator(() => o.h.core).issueSetupCode()!;
    expect(grant).not.toBeNull();
    const raw = grant.code;
    const shown = showSetupCode(raw);
    const forms = [raw, shown, shown.toLowerCase(), `${raw.slice(0, 4)} ${raw.slice(4)}`.toLowerCase()];
    const redact = o.h.core.ctx.redact;
    const serverLog = serverRedactor(() => null, new Set([raw]));
    expect({
      backend: forms.map((f) => leaks(redact.text(`코드: ${f}`), raw)),
      serverLog: forms.map((f) => leaks(serverLog(`코드: ${f}`), raw)),
    }).toEqual({ backend: [false, false, false, false], serverLog: [false, false, false, false] });
    // 다른 기기에서 로그인해 있던 대표가 콘솔 줄을 명령에 붙여 넣는다
    const sent = await invokeHttp(o.server.url, o.token, 'command.send', [{ target: 'main', text: `콘솔에 나온 설정 코드 ${shown}, 소문자로는 ${forms[2]}, 띄어 쓰면 ${forms[3]} 기억해 둬` }]);
    expect(sent.status).toBe(200);
    const conv = o.h.core.ctx.store.conversation.list({ ref1: 'main' }).map((m) => m.text).join('\n');
    const acts = o.h.core.ctx.store.activity.search({ limit: 1000 }).map((e) => `${e.text} ${e.result ?? ''}`).join('\n');
    expect({ conversation: leaks(conv, raw), activity: leaks(acts, raw), marked: conv.includes('[가림:setup-code]') }).toEqual({ conversation: false, activity: false, marked: true });
    // 그 꼴이 살아 있는 코드였다 — auth.setupOwner가 받는다
    expect((await invokeHttp(o.server.url, null, 'auth.setupOwner', [shown, 'owner@example.com'])).status).toBe(200);
  });
});
