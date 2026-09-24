/**
 * 데이터가 커질수록 쓰기가 느려지는 정도를 직접 잰다.
 *
 * 저장 구조가 "파일 전체를 읽어 고치고 전체를 다시 쓰기"이므로
 * 작업 수 N 에 비례해 한 번의 쓰기 비용이 커진다.
 * README 에 적은 수치는 이 스크립트로 얻은 것이고,
 * 아래 명령으로 누구나 다시 잴 수 있다.
 *
 *   npm run measure
 *
 * 수치는 기계와 디스크에 따라 달라진다. 절대값보다 N 에 따른 증가 경향을 보면 된다.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobsRepository } from '../dist/jobs/jobs.repository.js';

const SIZES = [100, 500, 1000, 5000, 10000];
const SAMPLES = 30;

const makeJob = (i) => ({
  id: `seed-${i}`,
  title: `job ${i}`,
  description: 'measurement fixture',
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

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];

const run = async () => {
  console.log(`node ${process.version} · ${process.platform}/${process.arch}`);
  console.log(`측정: 순차 쓰기 ${SAMPLES}회의 1회당 소요 시간\n`);
  console.log('     N   파일크기   쓰기 중앙값    쓰기 p95    읽기 중앙값');
  console.log('------  ---------  ------------  ----------  ------------');

  for (const size of SIZES) {
    const dir = mkdtempSync(join(tmpdir(), 'job-api-bench-'));
    const dbPath = join(dir, 'jobs.json');
    const repo = new JobsRepository({ dbPath, logPath: join(dir, 'logs.txt') });
    await repo.onModuleInit();

    // 기준 데이터를 한 번에 채운다.
    await repo.mutate((draft) => {
      for (let i = 0; i < size; i += 1) draft.jobs.push(makeJob(i));
    });

    const writes = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = process.hrtime.bigint();
      await repo.mutate((draft) => {
        draft.jobs.push(makeJob(size + i));
      });
      writes.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    const reads = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = process.hrtime.bigint();
      await repo.snapshot();
      reads.push(Number(process.hrtime.bigint() - started) / 1e6);
    }

    writes.sort((a, b) => a - b);
    reads.sort((a, b) => a - b);

    const kb = (statSync(dbPath).size / 1024).toFixed(0);
    console.log(
      `${String(size).padStart(6)}  ${(kb + ' KB').padStart(9)}  ` +
        `${(quantile(writes, 0.5).toFixed(2) + ' ms').padStart(12)}  ` +
        `${(quantile(writes, 0.95).toFixed(2) + ' ms').padStart(10)}  ` +
        `${(quantile(reads, 0.5).toFixed(2) + ' ms').padStart(12)}`,
    );

    rmSync(dir, { recursive: true, force: true });
  }
};

await run();
