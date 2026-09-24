import { describe, expect, it } from 'vitest';
import { Mutex } from './mutex.js';

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Mutex', () => {
  it('임계 구역이 겹치지 않는다', async () => {
    const mutex = new Mutex();
    let inside = 0;
    let maxInside = 0;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        mutex.runExclusive(async () => {
          inside += 1;
          maxInside = Math.max(maxInside, inside);
          await tick(1);
          inside -= 1;
        }),
      ),
    );

    expect(maxInside).toBe(1);
    expect(inside).toBe(0);
  });

  it('들어온 순서대로 실행된다(FIFO)', async () => {
    const mutex = new Mutex();
    const order: number[] = [];

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        mutex.runExclusive(async () => {
          // 먼저 대기열에 들어간 쪽이 더 오래 걸려도 순서는 유지되어야 한다.
          await tick(10 - i);
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('임계 구역이 예외를 던져도 잠금이 풀린다', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(mutex.isLocked).toBe(false);
    await expect(mutex.runExclusive(async () => 'ok')).resolves.toBe('ok');
  });

  it('갱신 손실을 막는다 — 잠금 없는 같은 작업과 비교', async () => {
    // 읽고 → 잠깐 양보하고 → 쓰는, 전형적인 read-modify-write.
    const makeCounter = () => {
      const state = { value: 0 };
      return {
        state,
        bump: async () => {
          const read = state.value;
          await tick(0); // 여기서 다른 작업이 끼어들 수 있다
          state.value = read + 1;
        },
      };
    };

    const unguarded = makeCounter();
    await Promise.all(Array.from({ length: 50 }, () => unguarded.bump()));

    const guarded = makeCounter();
    const mutex = new Mutex();
    await Promise.all(
      Array.from({ length: 50 }, () => mutex.runExclusive(guarded.bump)),
    );

    // 음성 대조군: 잠금이 없으면 실제로 손실이 난다.
    // 이 단언이 깨지면 위 테스트가 아무것도 증명하지 못하고 있다는 뜻이다.
    expect(unguarded.state.value).toBeLessThan(50);
    expect(guarded.state.value).toBe(50);
  });

  it('경합이 실제로 발생했는지 pending 으로 확인할 수 있다', async () => {
    const mutex = new Mutex();
    let observed = 0;

    const jobs = Array.from({ length: 5 }, () =>
      mutex.runExclusive(async () => {
        observed = Math.max(observed, mutex.pending);
        await tick(1);
      }),
    );

    await Promise.all(jobs);
    expect(observed).toBeGreaterThan(0);
  });
});
