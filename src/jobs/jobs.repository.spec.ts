import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../config/app.config.js';
import { InvalidDataFileError, JobsRepository } from './jobs.repository.js';
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

  it('깨진 JSON 파일이면 기동하지 않고 파일을 건드리지 않는다', async () => {
    writeFileSync(config.dbPath, '{"jobs": [');
    const fresh = new JobsRepository(config);
    await expect(fresh.onModuleInit()).rejects.toThrow(InvalidDataFileError);
    await expect(fresh.onModuleInit()).rejects.toThrow(config.dbPath);
    expect(readFileSync(config.dbPath, 'utf8')).toBe('{"jobs": [');
  });

  it('모양이 다른 파일이면 덮어쓰지 않고 거부한다', async () => {
    for (const bad of [
      '{"jobs": "not an array"}',
      '[]',
      '{"idempotency": []}',
    ]) {
      writeFileSync(config.dbPath, bad);
      const fresh = new JobsRepository(config);
      await expect(fresh.onModuleInit()).rejects.toThrow(InvalidDataFileError);
      expect(readFileSync(config.dbPath, 'utf8')).toBe(bad);
    }
  });

  it('레코드 하나라도 필드가 틀리면 몇 번째인지 찍고 거부한다', async () => {
    const base =
      '"description":"","createdAt":"x","updatedAt":"x","startedAt":null,"finishedAt":null,"result":null,"error":null';
    const cases: Array<[string, string]> = [
      [
        `{"jobs":[{"id":"a","title":null,"status":"pending","version":1,"attempts":0,${base}}]}`,
        'jobs[0].title',
      ],
      [
        `{"jobs":[{"id":"a","title":"t","status":"weird","version":1,"attempts":0,${base}}]}`,
        'jobs[0].status',
      ],
      [
        `{"jobs":[{"id":"a","title":"t","status":"pending","version":1,${base}}]}`,
        'jobs[0].attempts',
      ],
      [
        `{"jobs":[{"id":"a","title":"t","status":"pending","version":1,"attempts":0,${base}},{"id":"a","title":"u","status":"pending","version":1,"attempts":0,${base}}]}`,
        'jobs[1].id',
      ],
      ['{"jobs":[],"idempotency":{"k":1}}', 'idempotency["k"]'],
    ];
    for (const [content, where] of cases) {
      writeFileSync(config.dbPath, content);
      const fresh = new JobsRepository(config);
      await expect(fresh.onModuleInit()).rejects.toThrow(where);
      expect(readFileSync(config.dbPath, 'utf8')).toBe(content);
    }
  });

  it('없는 파일과 빈 파일은 새로 시작한다', async () => {
    writeFileSync(config.dbPath, '');
    const fresh = new JobsRepository(config);
    await fresh.onModuleInit();
    expect(await fresh.snapshot()).toEqual({ jobs: [], idempotency: {} });
  });

  it('쓰기가 실패하면 메모리를 디스크 내용으로 되돌린다', async () => {
    await repo.mutate((draft) => {
      draft.jobs.push(makeJob('persisted'));
    });

    // 파일 쓰기만 실패하게 만든다. node-json-db 는 이 전에 이미 메모리를 바꾼다.
    const adapter = (
      repo as unknown as {
        db: {
          config: { adapter: { writeAsync: (d: unknown) => Promise<void> } };
        };
      }
    ).db.config.adapter;
    const originalWrite = adapter.writeAsync.bind(adapter);
    adapter.writeAsync = async () => {
      throw new Error('EACCES: simulated');
    };

    await expect(
      repo.mutate((draft) => {
        draft.jobs.push(makeJob('phantom'));
      }),
    ).rejects.toThrow(/save the database/); // node-json-db 가 원인을 감싼다

    // 실패한 쓰기의 흔적이 메모리에 남아 있으면 안 된다.
    expect((await repo.snapshot()).jobs.map((j) => j.id)).toEqual([
      'persisted',
    ]);

    adapter.writeAsync = originalWrite;
    await repo.mutate((draft) => {
      draft.jobs.push(makeJob('after'));
    });
    expect((await repo.snapshot()).jobs.map((j) => j.id)).toEqual([
      'persisted',
      'after',
    ]);
    expect(JSON.parse(readFileSync(config.dbPath, 'utf8')).jobs).toHaveLength(
      2,
    );
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
