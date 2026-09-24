/**
 * 환경변수 기반 설정. 기본값만으로 바로 실행되고,
 * 테스트는 임시 파일 경로와 스케줄러 비활성화를 주입해서 쓴다.
 */
export interface AppConfig {
  /** 데이터 JSON 파일 경로 */
  dbPath: string;
  /** 요청·스케줄러 로그 파일 경로 */
  logPath: string;
  /** 스케줄러 자동 시작 여부 */
  schedulerEnabled: boolean;
  /** 스케줄러 실행 주기(ms) */
  schedulerIntervalMs: number;
  /** 한 번의 주기에서 집어갈 최대 작업 수 */
  schedulerBatchSize: number;
  /**
   * processing 상태로 이 시간(ms)을 넘기면 죽은 실행으로 보고 pending 으로 되돌린다.
   * 처리 도중 프로세스가 내려가면 작업이 영영 processing 에 갇히기 때문이다.
   */
  staleProcessingMs: number;
  /** 처리 실패를 흉내 내는 확률(0~1). 데모용이며 테스트에서는 0 또는 1 로 고정한다. */
  failureRate: number;
  /** 작업 하나를 처리하는 데 걸린다고 가정하는 시간(ms) */
  workDurationMs: number;
}

/**
 * 설정 값이 잘못됐을 때 던지는 예외. 프로세스가 뜨지 않는다.
 *
 * 없으면 기본값을 쓰지만, **있는데 틀리면 조용히 기본값으로 대체하지 않는다.**
 * `SCHEDULER_BATCH_SIZE=abc` 가 말없이 5 로 돌면, 운영자는 자기 설정이
 * 반영됐다고 믿은 채로 다른 값으로 돌아가는 서비스를 보게 된다.
 * 잘못된 설정은 요청 시점이 아니라 기동 시점에 실패해야 잡힌다.
 */
export class InvalidConfigError extends Error {
  constructor(name: string, raw: string, reason: string) {
    super(`Invalid environment variable ${name}='${raw}': ${reason}`);
    this.name = 'InvalidConfigError';
  }
}

const isBlank = (raw: string | undefined): raw is undefined =>
  raw === undefined || raw.trim() === '';

const num = (
  name: string,
  raw: string | undefined,
  fallback: number,
  range: { min?: number; max?: number } = {},
): number => {
  if (isBlank(raw)) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new InvalidConfigError(name, raw, 'must be a number');
  }
  if (range.min !== undefined && parsed < range.min) {
    throw new InvalidConfigError(name, raw, `must be >= ${range.min}`);
  }
  if (range.max !== undefined && parsed > range.max) {
    throw new InvalidConfigError(name, raw, `must be <= ${range.max}`);
  }
  return parsed;
};

const bool = (
  name: string,
  raw: string | undefined,
  fallback: boolean,
): boolean => {
  if (isBlank(raw)) return fallback;
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  throw new InvalidConfigError(name, raw, 'must be true/false or 1/0');
};

export const loadConfig = (
  env: NodeJS.ProcessEnv = process.env,
): AppConfig => ({
  dbPath: env.JOBS_DB_PATH ?? './jobs.json',
  logPath: env.LOG_FILE_PATH ?? './logs.txt',
  schedulerEnabled: bool('SCHEDULER_ENABLED', env.SCHEDULER_ENABLED, true),
  // 이런 처리기의 흔한 주기는 1분이지만 기본값을 10초로 낮췄다.
  // 실행해 보는 사람이 1분을 기다리지 않고 동작을 확인할 수 있어야 한다.
  schedulerIntervalMs: num(
    'SCHEDULER_INTERVAL_MS',
    env.SCHEDULER_INTERVAL_MS,
    10_000,
    { min: 1 },
  ),
  schedulerBatchSize: num('SCHEDULER_BATCH_SIZE', env.SCHEDULER_BATCH_SIZE, 5, {
    min: 1,
  }),
  staleProcessingMs: num(
    'STALE_PROCESSING_MS',
    env.STALE_PROCESSING_MS,
    60_000,
    { min: 1 },
  ),
  failureRate: num('JOB_FAILURE_RATE', env.JOB_FAILURE_RATE, 0.2, {
    min: 0,
    max: 1,
  }),
  workDurationMs: num('JOB_WORK_DURATION_MS', env.JOB_WORK_DURATION_MS, 50, {
    min: 0,
  }),
});

/** Nest DI 토큰 */
export const APP_CONFIG = Symbol('APP_CONFIG');
