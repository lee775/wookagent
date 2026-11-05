/**
 * 운영자 명령의 쓰임새 오류는 적은 낱말을 되풀이하지 않는다 (SERVER_DESIGN 3.2·3.7, 리드 결정 S3-8·S3-39 — 셋째 검토 security-surface의 프로브
 * zz-s3ss2-cli-secret-echo를 옮김). `config google-client-id <ID>`는 값을 명령 줄에 받으므로 `config google-client-secret GOCSPX-…`나 `secrets set …` 같은
 * 실수가 나기 쉽다. 프로브는 알 수 없는 명령의 글('알 수 없는 명령입니다: <적은 낱말 전부>')이 그 값을 stderr에 되풀이하는 것을 보였다.
 * - 'secret'이 든 낱말(대소문자 무관)이 있으면 SECRET_USAGE, 아니면 앞에서부터 이어지는 명령·묶음 이름만 보이고 나머지는 보이지 않는다고 말한다
 * - 다른 쓰임새 오류도 같다: 모르는 옵션은 이름도 보이지 않고('secret'이 들면 SECRET_USAGE), 포트는 숫자일 때만 되풀이한다
 * - 글은 공용 가리개(S3-14)를 한 번 더 거친다
 * 값은 진짜 비밀이 아닌 대역이다. 하나는 구글 보안 비밀 모양(가리개도 아는 꼴), 하나는 가리개가 모르는 꼴 — 되풀이하지 않는 것을 가리개와 따로 본다
 */
import { describe, expect, it } from 'vitest';
import { parseCli, runCli, SECRET_USAGE, usageError } from '../../src/server/cli';

/** 구글 보안 비밀 모양의 대역 ('secret'이라는 낱말은 들지 않는다 — 들면 SECRET_USAGE로 답해 되풀이 시험이 되지 않는다) */
const GOCSPX = 'GOCSPX-s3f5Standin0a1b2c3d4e5f6g7h';
/** 가리개가 모르는 꼴의 대역 */
const PLAIN = 'Standin7f3aQplainValue';
const VALUES = [GOCSPX, PLAIN];

/** runCli를 돌려 끝 코드와 stderr·stdout */
async function cli(argv: string[]): Promise<{ code: number | null; err: string; out: string }> {
  let err = '';
  let out = '';
  const code = await runCli(argv, { out: async (t: string) => void (out += t), err: async (t: string) => void (err += t) } as never);
  return { code, err, out };
}
const carries = (text: string) => VALUES.some((v) => text.includes(v));

describe('알 수 없는 명령은 적은 값을 되풀이하지 않는다 (S3-39)', () => {
  it('결정의 네 꼴 — 저마다 끝 코드 2이고 stderr에 값이 없다. secret이 든 둘은 SECRET_USAGE, 나머지 둘은 아는 이름만', async () => {
    for (const v of VALUES) {
      const forms: [string[], string][] = [
        [['config', 'google-client-secret', v], SECRET_USAGE],
        [['secrets', 'set', 'google-client-secret', v], SECRET_USAGE],
        [[v], '알 수 없는 명령입니다 (적은 낱말은 값일 수 있어 보이지 않습니다)'],
        [['config', v], '알 수 없는 명령입니다: config … (뒤의 낱말은 값일 수 있어 보이지 않습니다)'],
      ];
      for (const [argv, message] of forms) {
        const label = argv.map((w) => (w === v ? '<값>' : w)).join(' ');
        expect(parseCli(argv, {}, process.platform), label).toEqual({ kind: 'error', message });
        const r = await cli(argv);
        expect({ code: r.code, startsRight: r.err.startsWith(`${message}\n`), carries: carries(r.err) || carries(r.out) }, label).toEqual({ code: 2, startsRight: true, carries: false });
      }
    }
  });

  it("'secret'이 든 낱말은 자리·대소문자와 상관없이 SECRET_USAGE — 프로브의 다른 두 꼴 포함", () => {
    for (const argv of [
      ['config', 'secret', 'set', GOCSPX],
      ['set', 'google-client-secret', GOCSPX],
      ['CONFIG', 'Google-Client-SECRET', PLAIN],
      ['status', PLAIN, 'mySecretThing'],
      ['secret', 'set', 'google-client-secret', PLAIN],
    ]) {
      expect(parseCli(argv, {}, process.platform), argv.slice(0, 2).join(' ')).toEqual({ kind: 'error', message: SECRET_USAGE });
    }
  });

  it('앞에서부터 이어지는 명령·묶음 이름만 보인다 — 모두 아는 이름이면 그대로, 모르는 낱말부터는 보이지 않는다', () => {
    const message = (argv: string[]) => (parseCli(argv, {}, process.platform) as { message: string }).message;
    expect(message(['session'])).toBe('알 수 없는 명령입니다: session');
    expect(message(['config', 'show', 'reload'])).toBe('알 수 없는 명령입니다: config show reload');
    expect(message(['status', PLAIN])).toBe('알 수 없는 명령입니다: status … (뒤의 낱말은 값일 수 있어 보이지 않습니다)');
    expect(message(['config', 'owner-email', 'owner@example.com', PLAIN])).toBe('알 수 없는 명령입니다: config owner-email … (뒤의 낱말은 값일 수 있어 보이지 않습니다)');
    expect(message([PLAIN, 'status'])).toBe('알 수 없는 명령입니다 (적은 낱말은 값일 수 있어 보이지 않습니다)');
  });
});

describe('다른 쓰임새 오류도 값을 되풀이하지 않는다 (S3-39)', () => {
  it('모르는 옵션은 이름도 보이지 않는다 — 값을 옵션 자리에 붙였을 수 있다. secret이 든 옵션은 SECRET_USAGE', async () => {
    for (const v of VALUES) {
      for (const argv of [[`--${v}`], [`--${v}=x`], ['status', `--${v}`], [`-${v}`]]) {
        expect(parseCli(argv, {}, process.platform)).toEqual({ kind: 'error', message: '모르는 옵션이 있습니다 (적은 옵션은 값일 수 있어 보이지 않습니다)' });
        const r = await cli(argv);
        expect({ code: r.code, carries: carries(r.err) || carries(r.out) }).toEqual({ code: 2, carries: false });
      }
    }
    expect(parseCli(['--prot', '8080'], {}, process.platform)).toEqual({ kind: 'error', message: '모르는 옵션이 있습니다 (적은 옵션은 값일 수 있어 보이지 않습니다)' });
    for (const argv of [[`--google-client-secret=${GOCSPX}`], ['--client-secret', PLAIN], [`--Client-SECRET=${PLAIN}`]]) {
      expect(parseCli(argv, {}, process.platform)).toEqual({ kind: 'error', message: SECRET_USAGE });
    }
  });

  it('포트는 숫자일 때만 되풀이한다 — 숫자가 아니면 보이지 않는다고 말한다', async () => {
    expect(parseCli(['--port', '70000'], {}, process.platform)).toEqual({ kind: 'error', message: '포트 번호가 올바르지 않습니다: 70000' });
    for (const v of VALUES) {
      expect(parseCli(['--port', v], {}, process.platform)).toEqual({
        kind: 'error',
        message: '포트 번호가 올바르지 않습니다 — 0부터 65535까지의 숫자를 넣으세요 (숫자가 아닌 값은 보이지 않습니다)',
      });
      const r = await cli(['serve', '--port', v]);
      expect({ code: r.code, carries: carries(r.err) || carries(r.out) }).toEqual({ code: 2, carries: false });
    }
  });

  it('아는 옵션의 잘못(값 없음·값을 받지 않음)은 그 옵션 이름만 말한다', () => {
    const json = parseCli([`--json=${PLAIN}`], {}, process.platform) as { kind: string; message: string };
    const port = parseCli(['--port'], {}, process.platform) as { kind: string; message: string };
    expect([json.kind, json.message.includes('--json'), carries(json.message), port.kind, port.message.includes('--port')]).toEqual(['error', true, false, 'error', true]);
  });

  it('쓰임새 오류의 글은 공용 가리개를 거친다 (S3-14) — 세션 토큰·구글 보안 비밀 모양이 섞여도 가린다', () => {
    const token = `wos_${'K'.repeat(43)}`;
    const e = usageError(`앞 ${GOCSPX} 가운데 ${token} 끝`);
    expect([e.kind, e.message.includes(GOCSPX), e.message.includes(token), e.message.startsWith('앞 '), e.message.endsWith(' 끝')]).toEqual(['error', false, false, true, true]);
  });
});
