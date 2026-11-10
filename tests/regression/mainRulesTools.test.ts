/**
 * 메인 에이전트가 새 책임을 안다 (SERVER_DESIGN 2.6·10.1 'MAIN_RULES: 대표 명령 우선 처리(CTL-06의 새 뜻), 운영 도구 쓰는 법').
 * - 메인 에이전트에게 열린 앱 도구(팀원 공용 도구 빼고)는 모두 메인 세션 지침에 이름이 나온다 — 도구를 더하고 지침을 잊으면 실패한다.
 * - 지침은 대표 명령 우선, 대표 화면에 운영 조작이 없다는 것, 정지 해제·수정 요청·긴급 지시·대체 검수·운영자 몫 설정을 말한다.
 * - 없어진 대표 권한(대표 직접 메시지·대표 검수·대표 고정)을 할 일로 안내하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { MAIN_AGENT_ID, type Member, type SessionKind } from '@shared/domain';
import { TOOL_SPECS } from '../../src/main/mcp/catalog';
import { buildSystemPrompt } from '../../src/main/orchestrator/prompts';

const MAIN = { id: MAIN_AGENT_ID, name: '메인 에이전트', isMain: true, isProducer: false, roleId: 'main', projectId: null } as unknown as Member;
const promptFor = (sessionKind: SessionKind): string =>
  buildSystemPrompt({ member: MAIN, role: null, project: null, sessionKind, cwd: 'C:\\wook\\main-agent', manualSkills: [] });

describe('메인 에이전트 지침 (MAIN_RULES, v0.6 권한 모델)', () => {
  it('메인 에이전트에게 열린 도구는 모두 메인 지침에 나온다 (팀원 공용 도구 get_work_context·send_message 빼고)', () => {
    const mainTools = TOOL_SPECS.filter((t) => (t.roles as readonly string[]).includes('main') && !(t.roles as readonly string[]).includes('member')).map((t) => t.name);
    expect(mainTools).toEqual(expect.arrayContaining(['update_settings', 'revise_directive', 'resolve_recovery', 'resume_task', 'cancel_task', 'instruct_member']));
    // 전체 그림과 조회 도구 (SERVER_DESIGN 5.2, 리드 결정 S5-6)
    expect(mainTools).toEqual(expect.arrayContaining(['get_overview', 'get_member_activity', 'read_report', 'list_questions', 'search_activity']));
    // 서버 명령 (SERVER_DESIGN 8.2, 리드 결정 S5-16)
    expect(mainTools).toContain('host_exec');
    // 화면 조작 다섯 개 (SERVER_DESIGN 8.3.3, 리드 결정 S6-3)
    expect(mainTools).toEqual(expect.arrayContaining(['screen_capture', 'screen_info', 'gui_input', 'get_screen_check', 'answer_screen_check']));
    for (const kind of ['main_general', 'main_project'] as const) {
      const p = promptFor(kind);
      expect(mainTools.filter((n) => !p.includes(n)), `${kind} 지침에 없는 도구`).toEqual([]);
    }
  });

  it('대표 명령 우선과 메인이 맡은 운영을 말하고, 없어진 대표 권한을 안내하지 않는다', () => {
    const p = promptFor('main_general');
    for (const s of [
      '대표의 명령은 네 이전 결정과 프로듀서·팀원의 판단보다 우선해 처리한다 (CTL-06)',
      '대표 화면에는 팀·작업 조작이 없다',
      '긴급 정지 해제는 대표만 한다',
      '업무 "정지 해제"',
      '업무 "수정 요청"',
      'instruct_member(urgent: true)',
      '업무 "검수자 없음"',
      '보안 정책(민감 영역·긴급 정지 단축키)·기록 보관 기간·자동 백업 켜기·로그인 때 실행은 운영자 몫',
      'reason',
      'request_id',
      // 매 턴 현황 요약과 전체 현황·조회 도구 (SERVER_DESIGN 5.1·5.2, 리드 결정 S5-4·S5-6)
      '턴 메시지 맨 앞의 "현황 요약"은 그 턴을 띄울 때 계산한 전체 현황이다',
      'get_overview(',
      // 복구 확인 항목(recovery_id)은 현황에서 찾는다 — 대표가 알려 줄 때까지 기다리지 않는다
      '항목(recovery_id = requestId)은 get_overview의 메인이 할 일(main.recovery)에 있다',
      // 서버 명령은 앱의 기록·정지 안에서, 프로젝트 파일은 정해진 길로만 (SERVER_DESIGN 8.1·8.4, 리드 결정 S5-16·S5-17)
      'host_exec(command, purpose, request_id',
      '프로젝트 파일은 host_exec나 네 셸·화면 조작(편집기 열기 등)으로 직접 고치지 않는다',
      // 화면 조작은 서버 PC에만, 비밀 값·암호 칸은 치지 않고, UAC·잠금은 사람에게 (SERVER_DESIGN 8.3.5, 리드 결정 S6-8)
      '화면 조작은 서버 PC의 화면에만 한다',
      '비밀 값(키·토큰·비밀번호)은 치지 않고 암호 칸에는 입력하지 않는다(secret_blocked)',
      'UAC 확인 창·잠금 화면·보안 화면은 사람이 처리해야 하므로 ask_owner로 알린다',
      'GUI 프로그램은 네 셸이나 host_exec로 열고 그 턴 안에서만 쓴다',
    ]) expect(p, s).toContain(s);
    for (const s of ['대표 직접 메시지', '대표 검수', '대표 고정', '대표가 검수', 'members.sendMessage', 'tasks.ownerReview', '"owner"']) expect(p, s).not.toContain(s);
  });

  it('메인 에이전트가 검수자로 도는 검수 세션 지침에는 검수 규칙이 붙고, 그 밖의 메인 세션에는 붙지 않는다', () => {
    expect(promptFor('review')).toContain('## 검수 규칙 (메인 에이전트 대체 검수)');
    expect(promptFor('main_general')).not.toContain('## 검수 규칙');
  });
});
