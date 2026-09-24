import { describe, expect, it } from 'vitest';
import {
  canClientTransition,
  canTransition,
  isContentEditable,
} from './job.transitions.js';
import { JOB_STATUSES } from './job.entity.js';

describe('상태 전이 규칙', () => {
  it('스케줄러가 쓰는 전이', () => {
    expect(canTransition('pending', 'processing')).toBe(true);
    expect(canTransition('processing', 'completed')).toBe(true);
    expect(canTransition('processing', 'failed')).toBe(true);
    expect(canTransition('processing', 'pending')).toBe(true);
  });

  it('completed 는 종착점이다', () => {
    for (const to of JOB_STATUSES) {
      expect(canTransition('completed', to)).toBe(false);
    }
  });

  it('건너뛰는 전이는 막는다', () => {
    expect(canTransition('pending', 'completed')).toBe(false);
    expect(canTransition('pending', 'failed')).toBe(false);
    expect(canTransition('failed', 'completed')).toBe(false);
  });

  it('클라이언트가 직접 할 수 있는 전이는 failed → pending 뿐이다', () => {
    const allowed: Array<[string, string]> = [];
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        if (canClientTransition(from, to)) allowed.push([from, to]);
      }
    }
    expect(allowed).toEqual([['failed', 'pending']]);
  });

  it('클라이언트 전이는 전체 규칙의 부분집합이다', () => {
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        if (canClientTransition(from, to)) {
          expect(canTransition(from, to)).toBe(true);
        }
      }
    }
  });

  it('내용 수정은 실행 중이거나 끝난 작업에는 허용하지 않는다', () => {
    expect(isContentEditable('pending')).toBe(true);
    expect(isContentEditable('failed')).toBe(true);
    expect(isContentEditable('processing')).toBe(false);
    expect(isContentEditable('completed')).toBe(false);
  });
});
