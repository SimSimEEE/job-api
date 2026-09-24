import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { createHarness, type Harness } from './harness.js';

/**
 * 이 파일의 구조는 "같은 워크로드를 가드를 켜고 한 번, 끄고 한 번" 이다.
 *
 * 켜고 통과하는 것만으로는 부족하다. 끄면 실제로 깨져야 그 테스트가
 * 가드 덕분에 통과한다고 말할 수 있다. 끄고도 통과하면 경합이 안 일어난 것이고
 * 그 테스트는 아무것도 증명하지 못한다.
 *
 * 끄는 방법은 흉내가 아니다. 저장소의 실제 뮤텍스를 통과형으로 바꾼다.
 */

const workloads = {
  async create100(server: Server): Promise<void> {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        request(server)
          .post('/jobs')
          .send({ title: `job-${i}` }),
      ),
    );
  },
  async patch50(server: Server): Promise<string> {
    const created = await request(server)
      .post('/jobs')
      .send({ title: 'target' });
    const id = created.body.id as string;
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(server)
          .patch(`/jobs/${id}`)
          .send({ description: `d-${i}` }),
      ),
    );
    return id;
  },
  /** 혼합 워크로드의 시드. 음성 대조군에서는 이 단계를 잠금을 켠 채로 돌린다. */
  async seedForMixed(server: Server): Promise<void> {
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(server)
          .post('/jobs')
          .send({ title: `mixed-${i}` }),
      ),
    );
  },
  /**
   * 처리기 한 주기와 API 요청을 동시에 돌린다.
   * 처리기는 한 번만 부른다 — running 표시 때문에 겹친 호출은 어차피 건너뛰어,
   * 세 번 불러도 실제로 도는 것은 하나뿐이다(외부 검토가 로그로 확인).
   */
  async mixed(server: Server, h: Harness): Promise<void> {
    await Promise.all([
      h.scheduler.runOnce(),
      ...Array.from({ length: 20 }, (_, i) =>
        request(server)
          .post('/jobs')
          .send({ title: `during-${i}` }),
      ),
      ...Array.from({ length: 20 }, () =>
        request(server).get('/jobs?limit=100'),
      ),
    ]);
  },
  /**
   * 멱등 키 경합은 HTTP 를 거치지 않고 서비스를 직접 부른다.
   * HTTP 로 던지면 뮤텍스를 꺼도 통과한다(매번 한 요청만 "키 없음"을 본다).
   * 같은 경로의 동시 생성은 깨지는데 이것만 통과하는 이유는 확정하지 못했다.
   * 서비스를 직접 25번 부르면 뮤텍스 없이 25건이 전부 만들어지는 것은 확인했다.
   */
  async idempotent25(h: Harness) {
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        h.service.create({ title: 'only once' }, 'same-key'),
      ),
    );
    return {
      distinctIds: new Set(results.map((r) => r.job.id)).size,
      fresh: results.filter((r) => !r.replayed).length,
    };
  },
};

describe('동시성 — 가드를 켠 상태', () => {
  let h: Harness;
  let server: Server;

  beforeEach(async () => {
    h = await createHarness();
    server = h.app.getHttpServer() as Server;
  });
  afterEach(async () => {
    await h.close();
  });

  it('동시 생성 100건이 하나도 유실되지 않는다', async () => {
    await workloads.create100(server);
    const onDisk = h.readDbFile();
    expect(onDisk.jobs).toHaveLength(100);
    expect(new Set(onDisk.jobs.map((j) => j.id)).size).toBe(100);
  });

  it('동시 수정 50건이 서로를 덮어쓰지 않는다', async () => {
    const id = await workloads.patch50(server);
    // 모든 쓰기가 반영됐다면 버전은 정확히 1 + 50. 하나라도 유실되면 모자란다.
    expect(h.readDbFile().jobs.find((j) => j.id === id)?.version).toBe(51);
  });

  it('같은 멱등 키 25건이 동시에 와도 작업은 하나만 생긴다', async () => {
    const { distinctIds, fresh } = await workloads.idempotent25(h);
    expect(distinctIds).toBe(1);
    expect(fresh).toBe(1);
    expect(h.readDbFile().jobs).toHaveLength(1);
  });

  it('API 요청과 스케줄러가 같이 돌아도 상태가 깨지지 않는다', async () => {
    await workloads.seedForMixed(server);
    await workloads.mixed(server, h);
    const jobs = h.readDbFile().jobs;
    expect(jobs).toHaveLength(60);
    for (const job of jobs) {
      expect(['pending', 'processing', 'completed', 'failed']).toContain(
        job.status,
      );
      if (job.status === 'completed') expect(job.finishedAt).not.toBeNull();
      if (job.status === 'pending') expect(job.startedAt).toBeNull();
    }
    // 같은 작업을 두 번 집어가지 않았다.
    expect(jobs.filter((j) => j.attempts > 1)).toEqual([]);
  });

  it('동시 쓰기 후에도 JSON 파일이 유효하다', async () => {
    await Promise.all([workloads.create100(server), h.scheduler.runOnce()]);
    const parsed = h.readDbFile();
    expect(Array.isArray(parsed.jobs)).toBe(true);
    expect(parsed.idempotency).toBeTypeOf('object');
  });
});

describe('동시성 — 음성 대조군: 실제 가드를 끄면 같은 워크로드가 깨진다', () => {
  let h: Harness;
  let server: Server;

  beforeEach(async () => {
    h = await createHarness();
    server = h.app.getHttpServer() as Server;
  });
  afterEach(async () => {
    await h.close();
  });

  // 아래 단언이 하나라도 실패한다면(= 가드 없이도 통과한다면),
  // 위 블록의 같은 테스트는 가드 덕분에 통과하는 것이 아니다.

  it('동시 생성 100건 → 유실된다', async () => {
    h.disableSerialization();
    await workloads.create100(server);
    expect(h.readDbFile().jobs.length).toBeLessThan(100);
  });

  it('동시 수정 50건 → 버전이 모자란다', async () => {
    h.disableSerialization();
    const id = await workloads.patch50(server);
    expect(h.readDbFile().jobs.find((j) => j.id === id)?.version).toBeLessThan(
      51,
    );
  });

  it('같은 멱등 키 25건 → 여러 개 만들어진다', async () => {
    h.disableSerialization();
    const { distinctIds, fresh } = await workloads.idempotent25(h);
    expect(distinctIds).toBeGreaterThan(1);
    expect(fresh).toBeGreaterThan(1);
  });

  it('API + 스케줄러 혼합 → 유실된다', async () => {
    // 시드는 잠금을 켠 채로 넣는다. 그래야 유실이 시드 단계가 아니라
    // 처리기와 요청이 겹치는 구간에서 난 것임을 분리해서 볼 수 있다.
    await workloads.seedForMixed(server);
    expect(h.readDbFile().jobs).toHaveLength(40);
    h.disableSerialization();
    await workloads.mixed(server, h);
    expect(h.readDbFile().jobs.length).toBeLessThan(60);
  });
});
