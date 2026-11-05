import { readFileSync, writeFileSync } from 'node:fs';

const files = [
  'src/renderer/src/api/fake/data.ts',
  'src/renderer/src/api/fake/index.ts',
  'src/renderer/src/api/fake/fake.test.ts',
  'src/renderer/src/screens/Home.tsx',
];
const replacements = [
  ['작은 카페 게임', '동네 산책 기록장'],
  ['little-cafe', 'walk-journal'],
  ['카페 주문 화면', '산책 기록 화면'],
  ['카페 메뉴 데이터', '산책 장소 데이터'],
  ['주문 화면', '기록 화면'],
  ['주문 흐름', '기록 흐름'],
  ['주문 완료', '기록 저장'],
  ['메뉴 카드', '장소 카드'],
  ['메뉴 데이터', '장소 데이터'],
  ['메뉴를 고릅니다', '장소를 고릅니다'],
  ['장바구니와 합계가 일치하는지', '기록 목록에 새 항목이 보이는지'],
  ['새 보고가 도착했습니다', '새 작업 보고를 확인해 주세요'],
];
for (const file of files) {
  const before = readFileSync(file, 'utf8');
  const after = replacements.reduce((text, [from, to]) => text.replaceAll(from, to), before);
  if (after !== before) writeFileSync(file, after);
}
