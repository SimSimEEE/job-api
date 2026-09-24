import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { createHarness, type Harness } from './harness.js';

describe('스케줄러', () => {
  let h: Harness;
  let server: Server;

  const seed = async (count: number): Promise<string[]> => {
    const ids: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const res = await request(server)
        .post('/jobs')
        .send({ title: `job ${i}` });
      ids.push(res.body.id as string);
    }
    return ids;
  };

  afterEach(async () => {
    await h?.close();
  });

  describe('처리 흐름', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 0 });
      server = h.app.getHttpServer() as Server;
    });

    it('pending 을 집어가 completed 로 끝낸다', async () => {
      await seed(3);
      const report = await h.scheduler.runOnce();

      expect(report).toMatchObject({
        claimed: 3,
        completed: 3,
        failed: 0,
        skipped: false,
      });

      const jobs = h.readDbFile().jobs;
      expect(jobs.every((job) => job.status === 'completed')).toBe(true);
      for (const job of jobs) {
        expect(job.attempts).toBe(1);
        expect(job.startedAt).not.toBeNull();
        expect(job.finishedAt).not.toBeNull();
        expect(job.result).not.toBeNull();
        expect(job.error).toBeNull();
        // 생성(1) + 집어감(2) + 마무리(3)
        expect(job.version).toBe(3);
      }
    });

    it('한 주기에 배치 크기만큼만 집어간다', async () => {
      await seed(12);
      h.config.schedulerBatchSize = 5;

      const first = await h.scheduler.runOnce();
      expect(first.claimed).toBe(5);

      const second = await h.scheduler.runOnce();
      expect(second.claimed).toBe(5);

      const third = await h.scheduler.runOnce();
      expect(third.claimed).toBe(2);

      const fourth = await h.scheduler.runOnce();
      expect(fourth.claimed).toBe(0);

      expect(
        h.readDbFile().jobs.every((job) => job.status === 'completed'),
      ).toBe(true);
    });

    it('이미 끝난 작업을 다시 집어가지 않는다', async () => {
      await seed(2);
      await h.scheduler.runOnce();
      const report = await h.scheduler.runOnce();

      expect(report.claimed).toBe(0);
      expect(h.readDbFile().jobs.every((job) => job.attempts === 1)).toBe(true);
    });

    it('처리할 것이 없으면 아무 일도 하지 않는다', async () => {
      const report = await h.scheduler.runOnce();
      expect(report).toMatchObject({ claimed: 0, completed: 0, failed: 0 });
    });
  });

  describe('실패 처리', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 1 });
      server = h.app.getHttpServer() as Server;
    });

    it('실패하면 failed 로 남고 오류가 기록된다', async () => {
      await seed(2);
      const report = await h.scheduler.runOnce();

      expect(report).toMatchObject({ claimed: 2, completed: 0, failed: 2 });

      for (const job of h.readDbFile().jobs) {
        expect(job.status).toBe('failed');
        expect(job.error).not.toBeNull();
        expect(job.result).toBeNull();
      }
    });

    it('실패한 작업을 자동으로 다시 집어가지 않는다', async () => {
      await seed(1);
      await h.scheduler.runOnce();
      const again = await h.scheduler.runOnce();

      expect(again.claimed).toBe(0);
      expect(h.readDbFile().jobs[0].attempts).toBe(1);
    });

    it('클라이언트가 되돌리면 다음 주기에 다시 집어간다', async () => {
      const [id] = await seed(1);
      await h.scheduler.runOnce();

      await request(server).patch(`/jobs/${id}`).send({ status: 'pending' });

      const report = await h.scheduler.runOnce();
      expect(report.claimed).toBe(1);
      expect(h.readDbFile().jobs[0].attempts).toBe(2);
    });
  });

  describe('동시 실행을 하나로 제한', () => {
    beforeEach(async () => {
      // 처리에 시간이 걸리게 해서 앞선 주기가 끝나기 전에 다음 주기가 오게 만든다.
      h = await createHarness({ failureRate: 0, workDurationMs: 40 });
      server = h.app.getHttpServer() as Server;
    });

    it('앞선 주기가 끝나기 전에 온 주기는 건너뛴다', async () => {
      await seed(3);

      const [first, second] = await Promise.all([
        h.scheduler.runOnce(),
        h.scheduler.runOnce(),
      ]);

      expect(first.skipped).toBe(false);
      expect(second.skipped).toBe(true);
      expect(second.claimed).toBe(0);

      // 참고: 두 번 집어가지 않는 것은 이 플래그가 아니라 집어가기가 임계 구역 안에서
      // processing 으로 바꾸기 때문이다. 플래그는 동시에 도는 주기 수를 제한한다.
      expect(h.readDbFile().jobs.every((job) => job.attempts === 1)).toBe(true);
    });

    it('건너뛴 사실을 기록한다', async () => {
      await seed(1);
      await Promise.all([h.scheduler.runOnce(), h.scheduler.runOnce()]);
      await h.logger.flush();

      const skipped = h
        .readLogLines()
        .filter(
          (line) => line.event === 'scheduler.tick' && line.skipped === true,
        );
      expect(skipped).toHaveLength(1);
    });
  });

  describe('방치된 processing 회수', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 0, staleProcessingMs: 1_000 });
      server = h.app.getHttpServer() as Server;
    });

    it('오래 머문 processing 을 pending 으로 되돌린다', async () => {
      const [id] = await seed(1);

      // 처리 도중 프로세스가 죽은 상황을 흉내 낸다.
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((candidate) => candidate.id === id)!;
        job.status = 'processing';
        job.attempts = 1;
        job.startedAt = new Date(Date.now() - 60_000).toISOString();
      });

      const report = await h.scheduler.runOnce();

      expect(report.recovered).toBe(1);
      // 같은 주기에서 되돌린 뒤 다시 집어가 처리까지 끝낸다.
      expect(report.claimed).toBe(1);
      expect(h.readDbFile().jobs[0].status).toBe('completed');
      expect(h.readDbFile().jobs[0].attempts).toBe(2);
    });

    it('아직 시간이 지나지 않은 processing 은 건드리지 않는다', async () => {
      const [id] = await seed(1);
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((candidate) => candidate.id === id)!;
        job.status = 'processing';
        job.startedAt = new Date().toISOString();
      });

      const report = await h.scheduler.runOnce();

      expect(report.recovered).toBe(0);
      expect(report.claimed).toBe(0);
      expect(h.readDbFile().jobs[0].status).toBe('processing');
    });
  });

  describe('마무리 단계의 소유권 확인', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 0 });
      server = h.app.getHttpServer() as Server;
    });

    it('회수 후 다시 집어간 작업에는 이전 실행의 결과를 쓰지 않는다', async () => {
      const [id] = await seed(1);

      // 실행 A 가 집어갔다(attempts=1).
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((j) => j.id === id)!;
        job.status = 'processing';
        job.attempts = 1;
        job.startedAt = new Date().toISOString();
      });
      // A 가 처리하는 동안 방치로 회수되고 실행 B 가 다시 집어갔다(attempts=2).
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((j) => j.id === id)!;
        job.attempts = 2;
        job.startedAt = new Date().toISOString();
      });

      // A 가 뒤늦게 자기 결과를 쓰려 한다. attempts=1 로 집어갔던 실행이다.
      const settle = (
        h.scheduler as unknown as {
          settle(
            jobId: string,
            claimedAttempts: number,
            outcome: { ok: boolean; detail: string },
          ): Promise<string>;
        }
      ).settle.bind(h.scheduler);

      const result = await settle(id, 1, {
        ok: true,
        detail: 'stale result from A',
      });
      expect(result).toBe('skipped');

      const job = h.readDbFile().jobs.find((j) => j.id === id)!;
      expect(job.status).toBe('processing');
      expect(job.attempts).toBe(2);
      expect(job.result).toBeNull();

      // B 의 결과는 정상적으로 기록된다.
      expect(await settle(id, 2, { ok: true, detail: 'from B' })).toBe(
        'completed',
      );
      expect(h.readDbFile().jobs.find((j) => j.id === id)!.result).toBe(
        'from B',
      );
    });

    it('건너뛴 이유를 기록한다', async () => {
      const [id] = await seed(1);
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((j) => j.id === id)!;
        job.status = 'processing';
        job.attempts = 2;
      });
      const settle = (
        h.scheduler as unknown as {
          settle(
            j: string,
            a: number,
            o: { ok: boolean; detail: string },
          ): Promise<string>;
        }
      ).settle.bind(h.scheduler);
      await settle(id, 1, { ok: true, detail: 'x' });
      await h.logger.flush();
      const line = h
        .readLogLines()
        .find((l) => l.event === 'job.settle_skipped');
      expect(line?.reason).toMatch(/claimed at attempt 1, now at 2/);
    });
  });

  describe('할 일이 없는 주기는 파일을 쓰지 않는다', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 0 });
      server = h.app.getHttpServer() as Server;
    });

    it('회수할 것도 집어갈 것도 없으면 저장을 건너뛴다', async () => {
      await seed(1);
      await h.scheduler.runOnce(); // 처리해서 completed 로

      const db = (
        h.repo as unknown as {
          db: { push: (...a: unknown[]) => Promise<void> };
        }
      ).db;
      const originalPush = db.push.bind(db);
      let pushes = 0;
      db.push = (...args) => {
        pushes += 1;
        return originalPush(...args);
      };

      const idle = await h.scheduler.runOnce();
      expect(idle).toMatchObject({ claimed: 0, recovered: 0 });
      expect(pushes).toBe(0);

      // 양성 대조군: 할 일이 생기면 쓴다.
      await seed(1);
      pushes = 0;
      await h.scheduler.runOnce();
      expect(pushes).toBeGreaterThan(0);
    });
  });

  describe('로그는 저장이 끝난 뒤에만 남는다', () => {
    beforeEach(async () => {
      h = await createHarness({ failureRate: 0 });
      server = h.app.getHttpServer() as Server;
    });

    it('저장이 실패한 주기는 집어갔다는 기록을 남기지 않는다', async () => {
      const [id] = await seed(1);

      // 파일 쓰기만 실패하게 만든다.
      const adapter = (
        h.repo as unknown as {
          db: {
            config: { adapter: { writeAsync: (d: unknown) => Promise<void> } };
          };
        }
      ).db.config.adapter;
      const originalWrite = adapter.writeAsync.bind(adapter);
      adapter.writeAsync = async () => {
        throw new Error('EACCES: simulated');
      };

      await expect(h.scheduler.runOnce()).rejects.toThrow();
      await h.logger.flush();

      const events = h.readLogLines().map((line) => line.event);
      expect(events).toContain('scheduler.tick_failed');
      expect(events).not.toContain('job.claimed');

      // 디스크도, 메모리도 집어간 적이 없다.
      expect(h.readDbFile().jobs.find((j) => j.id === id)?.status).toBe(
        'pending',
      );
      adapter.writeAsync = originalWrite;
      expect((await h.repo.findById(id))?.status).toBe('pending');
    });
  });

  describe('주기 실패가 프로세스를 죽이지 않는다', () => {
    it('저장이 실패해도 인터벌은 계속 돌고 API 는 응답한다', async () => {
      h = await createHarness({
        schedulerEnabled: true,
        schedulerIntervalMs: 30,
        failureRate: 0,
      });
      server = h.app.getHttpServer() as Server;

      // 디스크 쓰기 실패를 흉내 낸다. 이 뒤로 모든 주기가 던진다.
      (h.repo as unknown as { mutate: () => Promise<never> }).mutate =
        async () => {
          throw new Error('EACCES: simulated write failure');
        };

      // 몇 주기가 지나가게 둔다. 수정 전에는 첫 실패에서 unhandled rejection 으로 죽었다.
      await new Promise((resolve) => setTimeout(resolve, 200));
      await h.logger.flush();

      const failed = h
        .readLogLines()
        .filter((line) => line.event === 'scheduler.tick_failed');
      expect(failed.length).toBeGreaterThanOrEqual(2);
      expect(failed[0].message).toMatch(/simulated write failure/);

      // 프로세스가 살아 있고 읽기 경로는 그대로 동작한다.
      const res = await request(server).get('/jobs');
      expect(res.status).toBe(200);
    });
  });

  describe('설정', () => {
    it('비활성화하면 주기가 등록되지 않는다', async () => {
      h = await createHarness({ schedulerEnabled: false });
      const { SchedulerRegistry } = await import('@nestjs/schedule');
      const registry = h.app.get(SchedulerRegistry);
      expect(registry.doesExist('interval', 'job-processing')).toBe(false);
    });

    it('활성화하면 주기가 등록된다', async () => {
      h = await createHarness({
        schedulerEnabled: true,
        schedulerIntervalMs: 60_000,
      });
      const { SchedulerRegistry } = await import('@nestjs/schedule');
      const registry = h.app.get(SchedulerRegistry);
      expect(registry.doesExist('interval', 'job-processing')).toBe(true);
    });
  });
});
