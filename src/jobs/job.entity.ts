/** 작업의 상태. */
export const JOB_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export interface Job {
  id: string;
  title: string;
  description: string;
  status: JobStatus;
  /**
   * 낙관적 동시성 제어용 버전. 쓰기마다 1씩 오른다.
   * 클라이언트가 읽은 시점과 쓰는 시점 사이의 변경을 감지하는 데 쓴다.
   */
  version: number;
  /** 스케줄러가 집어간 횟수 */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  result: string | null;
  error: string | null;
}

/** 멱등 키 기록. 같은 키로 다시 들어온 생성 요청을 원래 결과로 돌려주기 위한 것. */
export interface IdempotencyRecord {
  jobId: string;
  /** 같은 키인데 본문이 다르면 거절하기 위해 본문 지문을 같이 둔다. */
  requestHash: string;
  createdAt: string;
}

/** jobs.json 의 최상위 구조. */
export interface JobDatabase {
  jobs: Job[];
  idempotency: Record<string, IdempotencyRecord>;
}

export const emptyDatabase = (): JobDatabase => ({ jobs: [], idempotency: {} });
