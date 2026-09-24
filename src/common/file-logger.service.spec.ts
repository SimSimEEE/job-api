import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/app.config.js';
import { FileLoggerService } from './file-logger.service.js';

describe('FileLoggerService', () => {
  let dir: string;
  let logger: FileLoggerService;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'job-logger-'));
    logPath = join(dir, 'logs.txt');
    logger = new FileLoggerService({ ...loadConfig({}), logPath });
  });

  afterEach(async () => {
    await logger.onApplicationShutdown();
    rmSync(dir, { recursive: true, force: true });
  });

  const lines = () =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it('한 줄에 하나의 JSON 을 쓴다', async () => {
    logger.log({ channel: 'http', event: 'request.finished', statusCode: 200 });
    await logger.flush();
    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ channel: 'http', statusCode: 200 });
    expect(typeof lines()[0].timestamp).toBe('string');
  });

  it('직렬화할 수 없는 값을 받아도 던지지 않는다', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() =>
      logger.log({
        channel: 'scheduler',
        event: 'job.claimed',
        payload: circular,
      }),
    ).not.toThrow();
    expect(() =>
      logger.log({ channel: 'scheduler', event: 'job.claimed', big: 10n }),
    ).not.toThrow();

    await logger.flush();
    const written = lines();
    expect(written).toHaveLength(2);
    for (const line of written) {
      expect(line.event).toBe('log.serialize_failed');
      expect(line.originalEvent).toBe('job.claimed');
      expect(typeof line.error).toBe('string');
    }
  });

  it('실패한 줄 뒤의 정상 줄도 그대로 기록된다', async () => {
    logger.log({ channel: 'http', event: 'before', big: 1n });
    logger.log({ channel: 'http', event: 'after' });
    await logger.flush();
    expect(lines().map((l) => l.event)).toEqual([
      'log.serialize_failed',
      'after',
    ]);
  });
});
