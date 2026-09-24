import { describe, expect, it } from 'vitest';
import { InvalidConfigError, loadConfig } from './app.config.js';

describe('loadConfig', () => {
  it('아무것도 주지 않으면 기본값으로 동작한다', () => {
    const config = loadConfig({});
    expect(config.schedulerBatchSize).toBe(5);
    expect(config.schedulerEnabled).toBe(true);
    expect(config.failureRate).toBe(0.2);
  });

  it('빈 문자열도 없는 것으로 본다', () => {
    expect(loadConfig({ SCHEDULER_BATCH_SIZE: '  ' }).schedulerBatchSize).toBe(
      5,
    );
  });

  it('유효한 값은 그대로 쓴다', () => {
    const config = loadConfig({
      SCHEDULER_BATCH_SIZE: '12',
      SCHEDULER_ENABLED: '0',
      JOB_FAILURE_RATE: '1',
    });
    expect(config.schedulerBatchSize).toBe(12);
    expect(config.schedulerEnabled).toBe(false);
    expect(config.failureRate).toBe(1);
  });

  it('있는데 숫자가 아니면 조용히 기본값으로 대체하지 않고 실패한다', () => {
    expect(() => loadConfig({ SCHEDULER_BATCH_SIZE: 'abc' })).toThrow(
      InvalidConfigError,
    );
  });

  it('범위를 벗어나면 실패한다', () => {
    expect(() => loadConfig({ JOB_FAILURE_RATE: '1.5' })).toThrow(/<= 1/);
    expect(() => loadConfig({ SCHEDULER_BATCH_SIZE: '0' })).toThrow(/>= 1/);
    expect(() => loadConfig({ SCHEDULER_INTERVAL_MS: '-10' })).toThrow(/>= 1/);
  });

  it('PORT 도 같은 검증을 거친다', () => {
    expect(loadConfig({}).port).toBe(3000);
    expect(loadConfig({ PORT: '8080' }).port).toBe(8080);
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(InvalidConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/<= 65535/);
    expect(() => loadConfig({ PORT: '0' })).toThrow(/>= 1/);
  });

  it('불리언은 true/false/1/0 만 받는다', () => {
    expect(() => loadConfig({ SCHEDULER_ENABLED: 'yes' })).toThrow(
      InvalidConfigError,
    );
  });

  it('실패 메시지에 변수 이름과 받은 값이 들어간다', () => {
    expect(() => loadConfig({ STALE_PROCESSING_MS: 'soon' })).toThrow(
      "STALE_PROCESSING_MS='soon'",
    );
  });
});
