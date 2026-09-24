import type { JobStatus } from './job.entity.js';

/**
 * 상태 전이 규칙.
 *
 *   pending    ──(스케줄러가 집어감)──▶ processing
 *   processing ──(처리 성공)──────────▶ completed
 *   processing ──(처리 실패)──────────▶ failed
 *   processing ──(실행이 죽어 방치)───▶ pending      (스케줄러 회수)
 *   failed     ──(클라이언트 재시도)──▶ pending
 *
 * completed 는 종착점이다.
 * failed 도 스케줄러 입장에서는 종착점이고, 다시 돌리는 것은 클라이언트의 명시적 선택이다.
 * 자동 재시도를 넣지 않은 이유는 README 에 적어 두었다.
 */
const ALLOWED: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['processing'],
  processing: ['completed', 'failed', 'pending'],
  completed: [],
  failed: ['pending'],
};

/** 클라이언트가 PATCH 로 직접 일으킬 수 있는 전이. 나머지는 스케줄러 몫이다. */
const CLIENT_ALLOWED: Record<JobStatus, readonly JobStatus[]> = {
  pending: [],
  processing: [],
  completed: [],
  failed: ['pending'],
};

export const canTransition = (from: JobStatus, to: JobStatus): boolean =>
  ALLOWED[from].includes(to);

export const canClientTransition = (from: JobStatus, to: JobStatus): boolean =>
  CLIENT_ALLOWED[from].includes(to);

export const clientTransitionsFrom = (from: JobStatus): readonly JobStatus[] =>
  CLIENT_ALLOWED[from];

/**
 * 클라이언트가 title·description 을 고칠 수 있는 상태.
 * 실행 중인 작업의 입력을 바꾸면 결과가 무엇에 대한 것인지 흐려지고,
 * 끝난 작업의 입력을 바꾸면 "무엇을 처리했는가"가 사후에 달라진다.
 */
export const isContentEditable = (status: JobStatus): boolean =>
  status === 'pending' || status === 'failed';
