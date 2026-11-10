/**
 * 화면 조작(gui_input key)으로 보내지 않는 키 조합 (SERVER_DESIGN 8.3.5 '막는 동작'·'비밀 값을 치지 않는다', 리드 결정 S6-8). 순수 함수다 — 창·포커스는 보지 않는다.
 *
 * 읽는 법은 화면 도우미(resources/desktophelper/DesktopHelper.cs KeyMap.Parse)와 같다: `+`로 나눈 낱말, 마지막 낱말이 키, 그 앞은 수정 키
 * (ctrl·control·alt·shift·win·meta·super — 대소문자 무시). 키는 이름(enter·delete·f12 …)이나 ASCII 글자 하나다. 도우미가 읽지 못하는 글은 여기서도 읽지 못한다
 * (null) — 처리기가 모양 검사에서 invalid로 거부해 도우미에 가지 않는다. 그래서 '여기서는 못 읽었는데 도우미는 읽는' 조합이 없다.
 *
 * 막는 조합:
 * - Win+L — 화면 잠금. 잠기면 화면 조작을 더 할 수 없고 사람이 풀어야 한다
 * - Ctrl+Alt+Del — Windows가 프로그램이 보낸 것을 받지 않는다. 조용히 아무 일도 없게 두지 않고 '보낼 수 없습니다'로 거부한다
 * - Ctrl+Alt+Shift+F12 — 서버 PC 앞 사람의 멈춤 단축키. 메인이 누르는 키가 아니다
 * - 붙여넣기 (Ctrl+V·Ctrl+Shift+V·Shift+Insert·Win+V) — 클립보드에 무엇이 들었는지 앱이 볼 수 없어 비밀 값 검사를 지나친다. 클립보드를 읽거나 쓰는 도구도 없다
 * 바탕 화면·작업 표시줄의 Alt+F4(Windows 종료 창)와 막힌 창이 포커스일 때의 키는 포커스를 아는 도우미가 막는다.
 *
 * 한계: 실수를 막는 장치다. 메뉴·클릭으로 가는 잠금·로그아웃·종료(시작 → 전원, Win+X 메뉴)와 마우스 오른쪽 메뉴의 붙여넣기는 막지 못한다 (KNOWN_ISSUES).
 */

export type KeyModifier = 'ctrl' | 'alt' | 'shift' | 'win';

export interface KeyCombo {
  mods: ReadonlySet<KeyModifier>;
  /** 이름 붙은 키는 대표 이름(소문자 — del → delete, ins → insert, return → enter …), 글자 키는 소문자 한 글자 */
  key: string;
  /** 글자 키인지 (ASCII 한 글자) — 이름 붙은 키가 아니다 */
  char: boolean;
}

export type DeniedKeyRule = '화면 잠금' | 'Ctrl+Alt+Del' | '멈춤 단축키' | '붙여넣기';

export interface DeniedKey {
  rule: DeniedKeyRule;
  /** 메인에게 가는 거부 글 — 사실과 대신 할 일 */
  text: string;
}

const MODIFIER_OF: Readonly<Record<string, KeyModifier>> = { ctrl: 'ctrl', control: 'ctrl', alt: 'alt', shift: 'shift', win: 'win', meta: 'win', super: 'win' };

/** 이름 붙은 키 → 대표 이름 (DesktopHelper.cs KeyMap.Named와 같은 목록) */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map<string, string>([
  ['enter', 'enter'],
  ['return', 'enter'],
  ['tab', 'tab'],
  ['esc', 'esc'],
  ['escape', 'esc'],
  ['space', 'space'],
  ['backspace', 'backspace'],
  ['delete', 'delete'],
  ['del', 'delete'],
  ['insert', 'insert'],
  ['ins', 'insert'],
  ['home', 'home'],
  ['end', 'end'],
  ['pageup', 'pageup'],
  ['pgup', 'pageup'],
  ['pagedown', 'pagedown'],
  ['pgdn', 'pagedown'],
  ['up', 'up'],
  ['down', 'down'],
  ['left', 'left'],
  ['right', 'right'],
  ['printscreen', 'printscreen'],
  ['prtsc', 'printscreen'],
  ['menu', 'menu'],
  ['apps', 'menu'],
  ['capslock', 'capslock'],
  ['plus', 'plus'],
  ['minus', 'minus'],
  ...Array.from({ length: 24 }, (_, i): [string, string] => [`f${i + 1}`, `f${i + 1}`]),
]);

/** 이름 붙은 키의 모든 이름 (다른 이름 포함 — 'del'·'return' …). 시험이 이 목록 전체를 암호 칸에 대어 본다 */
export const NAMED_KEY_NAMES: readonly string[] = Object.freeze([...NAMED_KEYS.keys()]);

/**
 * 글자를 찍지 않는 키 (이동·기능 키 — 대표 이름). 이 목록에 없는 키는 모두 글자 키다 — space·plus·minus와 모든 글자 하나 (리드 결정 S6-21 B2). 화면 도우미
 * (DesktopHelper.cs KeyMap.NonPrintable)와 가짜 도우미가 같은 목록을 쓴다. 빼는 쪽으로 정한 까닭: 새 이름 키를 더하고 이 목록을 잊어도 글자 키로 다뤄져
 * 암호 칸·모르는 포커스에서 막힌다 (막는 쪽이 기본)
 */
export const NON_PRINTABLE_KEYS: ReadonlySet<string> = new Set<string>([
  'enter',
  'tab',
  'esc',
  'backspace',
  'delete',
  'insert',
  'home',
  'end',
  'pageup',
  'pagedown',
  'up',
  'down',
  'left',
  'right',
  'printscreen',
  'menu',
  'capslock',
  ...Array.from({ length: 24 }, (_, i) => `f${i + 1}`),
]);

/**
 * 글자를 찍는 키 조합인지 — 메인이 준 조합으로 정한다 (리드 결정 S6-21 B2·S6-23 K1). 키가 이동·기능 키(NON_PRINTABLE_KEYS)면 글자 키가 아니다. 그 밖의 키는
 * - 수정 키가 없거나 Shift만 있으면 글자 키다
 * - Win 없이 Ctrl과 Alt가 함께 있으면(Shift는 있어도 된다) 글자 키다 — Windows에서 Ctrl+Alt는 AltGr이라, AltGr 자판(독일어 등)에서는 글자를 찍는다
 *   (독일어 Ctrl+Alt+Q = '@', Ctrl+Alt+E = '€', Ctrl+Alt+7 = '{')
 * - Ctrl만·Alt만 있거나 Win이 있으면 단축키다
 * 화면 도우미는 글자 키를 암호 칸과 어떤 칸인지 모르는 포커스에 보내지 않는다(secret_blocked). 막는 조합(Ctrl+Alt+Del 등)은 이보다 먼저 거부된다(deniedRuleOf).
 * 자판 배열이 그 글자에 요구하는 Ctrl+Alt(AltGr)는 메인이 준 것이 아니라 이 판정에 들지 않는다 — 그 글자는 수정 키 없이도 글자 키다. 배열을 아는 도우미는 보내는
 * 조합(배열이 더한 수정 키 포함)이 Win 없는 Ctrl+Alt여도 글자 키로 본다 — AltGr 자판의 'alt+@'(AltGr+Q가 된다)처럼, 이 함수가 단축키로 보는 조합을 막는 쪽으로만
 */
export function printableKey(c: KeyCombo): boolean {
  if (NON_PRINTABLE_KEYS.has(c.key) || c.mods.has('win')) return false;
  const ctrl = c.mods.has('ctrl');
  const alt = c.mods.has('alt');
  const altGr = ctrl && alt;
  return altGr || (!ctrl && !alt);
}

/**
 * gui_input type의 글에 든 제어 문자 (C0 — U+0000~U+001F — 와 U+007F). 있으면 첫 것의 이름('탭'·'줄바꿈'·'제어 문자 U+0007'), 없으면 null (리드 결정 S6-21 B1).
 * 탭·Enter는 포커스를 다음 칸으로 옮기거나 양식을 보낸다 — 한 번의 type에 들어 있으면 그 뒤 글자가 암호 칸 검사를 받지 않은 칸에 들어간다("아이디<Tab>비밀번호
 * <Enter>"). 그래서 type은 이런 글을 받지 않고, 탭·Enter는 gui_input key로 따로 보낸다. 화면 도우미도 같은 글을 거부한다(ERR BAD_TEXT). 치는 동안 앱이
 * 스스로 포커스를 옮기는 것(칸을 다 채우면 다음 칸으로 넘어가는 양식)은 도우미가 4자마다 포커스를 다시 읽어 막는다 (리드 결정 S6-23 K2)
 */
export function controlCharIn(text: string): string | null {
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c > 0x1f && c !== 0x7f) continue;
    if (c === 0x09) return '탭';
    if (c === 0x0a || c === 0x0d) return '줄바꿈';
    return `제어 문자 U+${c.toString(16).toUpperCase().padStart(4, '0')}`;
  }
  return null;
}

/** KEY 조합 글의 상한 (도우미와 같다) */
export const KEY_COMBO_MAX = 60;

/** 'ctrl+shift+s' · 'enter' · 'A' 꼴을 읽는다. 읽지 못하면 null (도우미도 읽지 못한다) */
export function parseKeyCombo(text: string): KeyCombo | null {
  if (typeof text !== 'string' || text.length === 0 || text.length > KEY_COMBO_MAX) return null;
  const parts = text.split('+');
  const mods = new Set<KeyModifier>();
  for (let i = 0; i < parts.length; i++) {
    const raw = parts[i]!;
    if (raw.length === 0) return null;
    const p = raw.toLowerCase();
    const last = i === parts.length - 1;
    if (!last || raw.length > 1) {
      const mod = MODIFIER_OF[p];
      if (mod) {
        // 수정 키만으로 끝나는 조합은 없다
        if (last) return null;
        mods.add(mod);
        continue;
      }
    }
    if (!last) return null;
    if (raw.length > 1) {
      const named = NAMED_KEYS.get(p);
      return named ? { mods, key: named, char: false } : null;
    }
    const code = raw.charCodeAt(0);
    if (code < 0x21 || code > 0x7e) return null;
    return { mods, key: p, char: true };
  }
  return null;
}

const DENIED_TEXT: Readonly<Record<DeniedKeyRule, string>> = {
  '화면 잠금': '화면을 잠그는 키(Win+L)는 보내지 않습니다 — 잠기면 화면 조작을 더 할 수 없고 서버 PC 앞의 사람이 풀어야 합니다',
  'Ctrl+Alt+Del':
    'Ctrl+Alt+Del은 화면 조작으로 보낼 수 없습니다 (Windows가 프로그램이 보낸 이 키를 받지 않습니다) — 그 화면이 꼭 필요하면 사람이 눌러야 하니 ask_owner로 대표에게 알리세요',
  '멈춤 단축키': 'Ctrl+Alt+Shift+F12는 서버 PC 앞의 사람이 화면 조작을 멈추는 단축키라 보내지 않습니다',
  붙여넣기:
    '붙여넣기 키(Ctrl+V·Shift+Insert·Win+V)는 보내지 않습니다 — 클립보드에 무엇이 들었는지 앱이 볼 수 없어 비밀 값이 그대로 입력될 수 있습니다. 넣을 글은 gui_input type으로 치세요',
};

/** 읽은 조합이 막는 조합이면 그 규칙 — 아니면 null */
export function deniedRuleOf(c: KeyCombo): DeniedKeyRule | null {
  const has = (m: KeyModifier): boolean => c.mods.has(m);
  if (has('win') && c.key === 'l') return '화면 잠금';
  if (has('ctrl') && has('alt') && c.key === 'delete') return 'Ctrl+Alt+Del';
  if (has('ctrl') && has('alt') && has('shift') && c.key === 'f12') return '멈춤 단축키';
  // Ctrl+V와 Ctrl+Shift+V(글만 붙여넣기·터미널의 붙여넣기). Ctrl+Alt+V는 AltGr 글자라 붙여넣기가 아니다 — 글자 키라 암호 칸에는 막힌다(printableKey)
  if (has('ctrl') && !has('alt') && c.key === 'v') return '붙여넣기';
  if (has('win') && c.key === 'v') return '붙여넣기';
  if (has('shift') && !has('ctrl') && !has('alt') && c.key === 'insert') return '붙여넣기';
  return null;
}

/**
 * gui_input key의 조합이 막는 조합이면 그 규칙과 거부 글 — 아니면 null. 읽지 못하는 글은 null이다(막는 조합인지 모른다) — 부르는 쪽이 parseKeyCombo로 먼저
 * 거르고(invalid), 걸러지지 않은 채 오면 안전장치가 막는 쪽으로 다룬다(desktop/safety.ts)
 */
export function deniedKeyCombo(text: string): DeniedKey | null {
  const c = parseKeyCombo(text);
  if (!c) return null;
  const rule = deniedRuleOf(c);
  return rule ? { rule, text: DENIED_TEXT[rule] } : null;
}
