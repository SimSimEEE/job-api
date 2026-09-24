import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from '../src/app.module.js';
import { FileLoggerService } from '../src/common/file-logger.service.js';
import {
  APP_CONFIG,
  loadConfig,
  type AppConfig,
} from '../src/config/app.config.js';
import { JobsRepository } from '../src/jobs/jobs.repository.js';
import { JobsScheduler } from '../src/jobs/jobs.scheduler.js';
import { JobsService } from '../src/jobs/jobs.service.js';
import type { JobDatabase } from '../src/jobs/job.entity.js';

export interface Harness {
  app: INestApplication;
  config: AppConfig;
  repo: JobsRepository;
  service: JobsService;
  scheduler: JobsScheduler;
  logger: FileLoggerService;
  /** 디스크에 실제로 저장된 내용. 메모리 상태가 아니라 파일을 직접 읽는다. */
  readDbFile(): JobDatabase;
  /** logs.txt 를 JSON Lines 로 파싱해서 돌려준다. */
  readLogLines(): Array<Record<string, unknown>>;
  /**
   * 저장소의 뮤텍스를 통과형으로 바꾼다. 음성 대조군 전용.
   * 흉내 낸 가드가 아니라 실제 가드를 끄고, 같은 테스트가 깨지는지 본다.
   */
  disableSerialization(): void;
  close(): Promise<void>;
}

/**
 * 테스트마다 임시 디렉터리에 데이터 파일과 로그 파일을 따로 만든다.
 * 스케줄러는 기본적으로 꺼 두고, 필요한 테스트가 runOnce() 를 직접 부른다.
 * 타이머에 기대면 테스트가 느려지고 간헐적으로 실패한다.
 */
export const createHarness = async (
  overrides: Partial<AppConfig> = {},
): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), 'job-api-test-'));
  const config: AppConfig = {
    ...loadConfig({}),
    dbPath: join(dir, 'jobs.json'),
    logPath: join(dir, 'logs.txt'),
    schedulerEnabled: false,
    failureRate: 0,
    workDurationMs: 0,
    ...overrides,
  };

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(config)
    .compile();

  const app = moduleRef.createNestApplication();
  const { configureApp } = await import('../src/setup.js');
  configureApp(app);
  // init() 만 하면 supertest 가 요청마다 listen(0) 을 새로 걸어
  // 리스너가 쌓인다는 경고가 뜬다. 여기서 한 번 띄워 두고 재사용한다.
  await app.listen(0);

  const logger = app.get(FileLoggerService);

  return {
    app,
    config,
    repo: app.get(JobsRepository),
    service: app.get(JobsService),
    scheduler: app.get(JobsScheduler),
    logger,
    readDbFile: () =>
      JSON.parse(readFileSync(config.dbPath, 'utf8')) as JobDatabase,
    readLogLines: () =>
      readFileSync(config.logPath, 'utf8')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    disableSerialization: () => {
      const repo = app.get(JobsRepository) as unknown as {
        mutex: { runExclusive: <T>(fn: () => Promise<T> | T) => Promise<T> };
      };
      repo.mutex.runExclusive = async (fn) => fn();
    },
    close: async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};
