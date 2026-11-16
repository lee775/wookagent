/**
 * 팀원 이름 — 모든 팀원은 사람 이름을 가진다 (대표 지시 2026-11-16: "각 직원들 이름 전부 지어주도록 해줘 코덱스 개발1 이런식은 너무 별로야").
 * - 이름을 주지 않고 추가한 팀원은 프로그램이 아래 목록에서 짓는다. 다른 프로젝트에서 쓰는 이름도 피한다 — 사무실에서 부서마다 같은 이름이 보이지 않게.
 * - 메인 에이전트가 지은 이름은 사람 이름일 때만 받는다. AI 종류·역할·번호로 만든 이름(코덱스 개발1, 검수 담당)은 받지 않고 프로그램이 짓는다 (team.ts).
 */

/**
 * 기본 이름 (앞에서부터). 참고했던 다른 앱의 팀 이름(하루·도윤·모아·리듬·이야·체크·소담)은 쓰지 않는다 — 대표 지시 "이러면 베낀 거잖아"
 */
export const NAME_POOL: readonly string[] = [
  '서진', '윤슬', '한결', '지안', '도담', '여울', '시우', '채원', '로운', '은재', '가온', '해솔',
  '다인', '주원', '세아', '이안', '건우', '수아', '별하', '태린', '민재', '예린', '초아', '규민',
  '하린', '도현', '서율', '나윤', '유찬', '소율', '지호', '아린', '현우', '다온', '라온', '새봄',
  '이든', '하람', '시온', '유나', '재이', '보민', '선우', '나래', '슬아', '단비', '은솔', '마루',
  '누리', '한울', '다솜', '소이', '지유', '연우', '태오', '하준', '서아', '지후', '예준', '아윤',
  '시아', '준서', '채아', '로이', '미르', '가람', '한별', '솔빈', '이서', '정안', '유주', '해린',
];

/** 기본 이름을 다 쓴 뒤에 붙이는 성 — 성 + 기본 이름 */
const SURNAMES: readonly string[] = ['김', '이', '박', '최', '정', '강', '윤', '한', '오', '신'];

/** 사람 이름으로 받는 글: 한글 2~4자 (띄어쓰기·숫자·영문·기호 없음) */
const PERSON_NAME_RE = /^[가-힣]{2,4}$/;

/** 이름에 들어 있으면 사람 이름이 아닌 말 — AI 이름, 직함, 역할을 가리키는 말 */
const LABEL_WORDS: readonly string[] = [
  '코덱스', '클로드', '제미나이', '지피티', '에이전트', '에이아이', '로봇',
  '팀원', '직원', '사원', '담당', '팀장', '대표',
  '개발', '검수', '리뷰', '기획', '설계', '디자', '테스', '프로듀', '매니저', '엔지니', '프론트', '백엔드', '큐에이',
];

/**
 * 사람 이름인지 — 한글 2~4자이고, AI·직함·역할을 가리키는 말이 없고, 역할 이름(또는 그 일부)이 아니다.
 * roleNames: 지금 있는 역할의 이름 ('UI 디자이너' → '디자이너'도 사람 이름이 아니다)
 */
export function isPersonName(name: string, roleNames: readonly string[] = []): boolean {
  const n = name.trim();
  if (!PERSON_NAME_RE.test(n)) return false;
  if (LABEL_WORDS.some((w) => n.includes(w))) return false;
  return !roleNames.some((r) => r.replace(/\s+/g, '').includes(n));
}

/** 프로그램이 지을 수 있는 이름 전부 — 기본 이름, 그다음 성을 붙인 이름 */
export function nameCandidates(): string[] {
  return [...NAME_POOL, ...SURNAMES.flatMap((s) => NAME_POOL.map((n) => `${s}${n}`))];
}

/**
 * 새 이름을 고른다 — 어느 프로젝트에서도 쓰지 않는 이름을 먼저, 다 썼으면 이 프로젝트에서 쓰지 않는 이름. 사람 이름이 아닌 것으로 걸러지는 이름(roleNames에
 * 걸리는 것)은 건너뛴다. 남은 이름이 없으면 null
 */
export function pickPersonName(usedHere: ReadonlySet<string>, usedAnywhere: ReadonlySet<string>, roleNames: readonly string[] = []): string | null {
  const all = nameCandidates().filter((n) => isPersonName(n, roleNames));
  return all.find((n) => !usedAnywhere.has(n) && !usedHere.has(n)) ?? all.find((n) => !usedHere.has(n)) ?? null;
}
