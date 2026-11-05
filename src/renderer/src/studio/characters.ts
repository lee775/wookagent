import type { MemberView } from '../../../shared/views';

export interface Appearance { skin: string; hair: string; shirt: string; trouser: string; accent: string; hairStyle: number; headShape: number; build: number; glasses: boolean; accessory: number; eyes: number; brow: number; nose: number; beard: boolean; freckles: boolean; ageLines: boolean }

export function hashId(id: string): number {
  let value = 2166136261;
  for (const letter of id) value = Math.imul(value ^ letter.charCodeAt(0), 16777619);
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13;
  value = Math.imul(value, 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}
export type DeskItemKind = 'mug' | 'notebook' | 'plant' | 'figurine' | 'headphones' | 'photo' | 'pen';
const deskSets: DeskItemKind[][] = [
  ['mug', 'notebook'], ['plant', 'pen'], ['figurine', 'photo'], ['headphones', 'notebook'],
  ['mug', 'plant'], ['pen', 'photo'], ['figurine', 'notebook'], ['headphones', 'photo'],
  ['mug', 'pen'], ['plant', 'photo'], ['figurine', 'pen'], ['headphones', 'plant'],
];
export function deskItemsFor(id: string, index: number): DeskItemKind[] {
  const pair = deskSets[index % deskSets.length];
  return hashId(`${id}:desk-order`) % 2 ? [...pair].reverse() : [...pair];
}

const skins = ['#efbb91', '#d99b72', '#a76c50', '#eeb39b', '#c6855c', '#815945'];
const hairs = ['#282a29', '#5c382e', '#876144', '#363c4a', '#9a573c', '#464036', '#a8a9a4', '#313e47'];
const shirts = ['#396577', '#b8634e', '#717751', '#7b6075', '#c28c45', '#357e78', '#8f5873', '#587f9a', '#a36d36', '#4a8052', '#824f4a', '#59658d'];
const trousers = ['#28383b', '#3f4751', '#5c4c44', '#3e4959'];
const accents: Record<string, string> = { producer: '#ba6544', planner: '#c48c42', architect: '#557b7f', developer: '#4c8292', ui_designer: '#a6665f', qa: '#79795a', docs: '#916953' };

function makeAppearance(id: string, roleId: string, salt: number): Appearance {
  const trait = (name: string) => hashId(`${id}:${name}:${salt}`);
  return {
    skin: skins[trait('skin') % skins.length], hair: hairs[trait('hair-colour') % hairs.length],
    shirt: shirts[trait('shirt') % shirts.length], trouser: trousers[trait('trouser') % trousers.length],
    accent: accents[roleId] ?? '#79795a', hairStyle: trait('hair-style') % 8, headShape: trait('head-shape') % 3,
    build: trait('build') % 3, glasses: trait('glasses') % 3 === 0,
    accessory: trait('accessory') % 4, eyes: trait('eyes') % 4, brow: trait('brow') % 4,
    nose: trait('nose') % 3, beard: trait('beard') % 9 === 0, freckles: trait('freckles') % 7 === 0, ageLines: trait('age') % 11 === 0,
  };
}
function lab(hex: string): [number, number, number] {
  const channel = (start: number) => { const c = parseInt(hex.slice(start, start + 2), 16) / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  const r = channel(1), g = channel(3), b = channel(5);
  const x = (r * .4124564 + g * .3575761 + b * .1804375) / .95047;
  const y = r * .2126729 + g * .7151522 + b * .072175;
  const z = (r * .0193339 + g * .119192 + b * .9503041) / 1.08883;
  const f = (c: number) => c > .008856 ? Math.cbrt(c) : c * 7.787 + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
export function colourDistance(a: string, b: string): number {
  const p = lab(a), q = lab(b);
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}
const sequentialLooks: Appearance[] = [];
export function appearanceFor(member: Pick<MemberView, 'id' | 'roleId' | 'isMain'>): Appearance {
  const numeric = /^M-(\d{4})$/.exec(member.id);
  if (!numeric) return makeAppearance(member.id, member.roleId, 0);
  const number = Number(numeric[1]);
  for (let n = sequentialLooks.length + 1; n <= number; n++) {
    const id = `M-${String(n).padStart(4, '0')}`;
    const neighbours = sequentialLooks.slice(Math.max(0, n - 12));
    let candidate = makeAppearance(id, member.roleId, 0);
    for (let salt = 1; salt < 1000; salt++) {
      if (neighbours.every(other => other.skin !== candidate.skin || colourDistance(other.hair, candidate.hair) >= 12) &&
          neighbours.every(other => other.hairStyle !== candidate.hairStyle ||
            colourDistance(other.hair, candidate.hair) >= 15 || colourDistance(other.skin, candidate.skin) >= 10) &&
          neighbours.filter(other => other.hairStyle === candidate.hairStyle).length < 3 &&
          neighbours.filter(other => other.shirt === candidate.shirt).length < 2) break;
      candidate = makeAppearance(id, member.roleId, salt);
    }
    sequentialLooks.push(candidate);
  }
  return { ...sequentialLooks[number - 1], accent: accents[member.roleId] ?? '#79795a' };
}
