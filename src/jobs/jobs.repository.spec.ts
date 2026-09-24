import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../config/app.config.js';
import { JobsRepository } from './jobs.repository.js';
import type { Job } from './job.entity.js';

const makeJob = (id: string): Job => ({
  id,
  title: id,
  description: '',
  status: 'pending',
  version: 1,
  attempts: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
});

describe('JobsRepository', () => {
  let dir: string;
  let config: AppConfig;
  let repo: JobsRepository;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'job-repo-'));
    config = {
      ...loadConfig({}),
      dbPath: join(dir, 'jobs.json'),
      logPath: join(dir, 'logs.txt'),
    };
    repo = new JobsRepository(config);
    await repo.onModuleInit();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('파일이 없으면 빈 구조로 시작한다', async () => {
    const snapshot = await repo.snapshot();
    expect(snapshot).toEqual({ jobs: [], idempotency: {} });
  });

  it('snapshot 을 고쳐도 저장소에 영향이 없다', async () => {
    // node-json-db 의 getData 는 내부 객체의 참조를 그대로 준다.
    // 저장소가 복사해 주지 않으면 이 수정이 그대로 반영된다.
    const snapshot = await repo.snapshot();
    snapshot.jobs.push(makeJob('sneaky'));

    expect((await repo.snapshot()).jobs).toHaveLength(0);
  });

  it('mutate 가 던지면 아무것도 쓰이지 않는다', async () => {
    await repo.mutate((draft) => {
      draft.jobs.push(makeJob('keep'));
    });

    await expect(
      repo.mutate((draft) => {
        draft.jobs.push(makeJob('discard'));
        throw new Error('validation failed');
      }),
    ).rejects.toThrow('validation failed');

    const jobs = (await repo.snapshot()).jobs;
    expect(jobs.map((job) => job.id)).toEqual(['keep']);

    // 디스크도 마찬가지여야 한다.
    const onDisk = JSON.parse(readFileSync(config.dbPath, 'utf8'));
    expect(onDisk.jobs).toHaveLength(1);
  });

  it('mutate 는 직렬화된다 — 동시 추가가 유실되지 않는다', async () => {
    const COUNT = 80;
    await Promise.all(
      Array.from({ length: COUNT }, (_, i) =>
        repo.mutate((draft) => {
          draft.jobs.push(makeJob(`job-${i}`));
        }),
      ),
    );

    expect((await repo.snapshot()).jobs).toHaveLength(COUNT);
  });

  it('경합이 실제로 일어났는지 확인할 수 있다', async () => {
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        repo.mutate(async (draft) => {
          peak = Math.max(peak, repo.pendingWrites);
          draft.jobs.push(makeJob(`j-${draft.jobs.length}`));
        }),
      ),
    );
    // 대기열이 한 번도 차지 않았다면 직렬화를 시험하지 못한 것이다.
    expect(peak).toBeGreaterThan(0);
  });

  it('손으로 편집된 파일도 받아 준다', async () => {
    // jobs 키가 없거나 형식이 어긋난 파일에서도 죽지 않아야 한다.
    writeFileSync(config.dbPath, JSON.stringify({ jobs: 'not an array' }));
    const fresh = new JobsRepository(config);
    await fresh.onModuleInit();

    expect(await fresh.snapshot()).toEqual({ jobs: [], idempotency: {} });
  });

  it('사람이 읽을 수 있는 형태로 저장한다', async () => {
    await repo.mutate((draft) => {
      draft.jobs.push(makeJob('readable'));
    });
    const raw = readFileSync(config.dbPath, 'utf8');
    expect(raw).toContain('\n');
    expect(raw).toContain('    ');
  });
});
