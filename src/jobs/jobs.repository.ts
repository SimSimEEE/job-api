import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { JsonDB, Config as JsonDbConfig } from 'node-json-db';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';
import { Mutex } from '../common/mutex.js';
import {
  emptyDatabase,
  JOB_STATUSES,
  type Job,
  type JobDatabase,
} from './job.entity.js';

const ROOT = '/';

/**
 * 데이터 파일을 쓸 수 없을 때 던진다. 프로세스가 뜨지 않는다.
 * 깨진 JSON 이나 모양이 다른 파일을 빈 구조로 덮어쓰면 그 안의 내용을 잃는다.
 * 없는 파일과 빈 파일만 새로 시작한다 — 잃을 것이 없기 때문이다.
 */
export class InvalidDataFileError extends Error {
  constructor(path: string, reason: string) {
    super(
      `Data file '${path}' cannot be used: ${reason}. Fix the file, or remove it to start fresh.`,
    );
    this.name = 'InvalidDataFileError';
  }
}

/**
 * 데이터 파일에 닿는 유일한 통로.
 *
 * 설계의 핵심은 두 가지다.
 *
 * 1) 모든 변경은 mutate() 를 거친다.
 *    "읽고 → 고치고 → 쓰기" 전체가 하나의 임계 구역 안에서 끝나므로,
 *    두 요청이 같은 낡은 스냅샷을 읽고 서로를 덮어쓰는 일이 없다.
 *    node-json-db 도 자체 read-write 잠금을 갖고 있지만 그것은 호출 하나 단위라
 *    연속된 두 호출 사이의 틈은 막아 주지 않는다.
 *
 * 2) 경계를 넘는 데이터는 복사한다.
 *    node-json-db 의 getData 는 내부 객체의 참조를 그대로 돌려준다.
 *    받은 쪽에서 무심코 수정하면 저장하지도 않은 변경이 다른 읽기에 보인다.
 *    읽을 때와 쓸 때 structuredClone 으로 끊어 그런 새어 나감을 막는다.
 *    큰 데이터에서는 이 복사가 비용이 되는데, 그 한계는 README 에 적었다.
 */
@Injectable()
export class JobsRepository implements OnModuleInit {
  private readonly db: JsonDB;
  private readonly mutex = new Mutex();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.db = new JsonDB(
      // (파일경로, 저장마다 flush, 사람이 읽을 수 있게 들여쓰기, 경로 구분자)
      new JsonDbConfig(this.config.dbPath, true, true, '/'),
    );
  }

  async onModuleInit(): Promise<void> {
    // 파일이 없거나 비어 있으면 빈 구조를 만들어 둔다.
    // 이후 모든 읽기가 jobs / idempotency 키의 존재를 가정할 수 있게 한다.
    // 파일이 있는데 읽을 수 없거나 모양이 다르면 덮어쓰지 않고 기동을 멈춘다.
    await this.mutex.runExclusive(async () => {
      let current: unknown;
      try {
        current = await this.readRaw();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new InvalidDataFileError(
          this.config.dbPath,
          `not valid JSON (${detail})`,
        );
      }
      const normalized = this.normalize(current);
      this.validateRecords(normalized);
      await this.db.push(ROOT, normalized, true);
    });
  }

  /** 경합 상황을 테스트에서 확인하기 위한 값. */
  get pendingWrites(): number {
    return this.mutex.pending;
  }

  /**
   * 읽기 전용 스냅샷. 호출자가 마음대로 고쳐도 저장소에 영향이 없다.
   *
   * 읽기에는 뮤텍스를 걸지 않는다. mutate() 는 완성된 상태를 한 번에 써 넣고,
   * JS 는 단일 스레드라 push() 사이에 읽기가 끼어들어 반쯤 쓰인 상태를 보는 일이 없다.
   * 쓰기를 기다리게 만들 이유가 없어 읽기는 그대로 통과시킨다.
   */
  async snapshot(): Promise<JobDatabase> {
    return this.normalize(await this.readRaw());
  }

  async findById(id: string): Promise<Job | undefined> {
    const { jobs } = await this.snapshot();
    return jobs.find((job) => job.id === id);
  }

  /**
   * 임계 구역 안에서 데이터를 통째로 바꾼다.
   *
   * mutator 는 현재 스냅샷을 받아 원하는 만큼 고친 뒤,
   * 호출자에게 돌려줄 값을 반환한다. mutator 안에서 다시 mutate() 를 부르면
   * 자기 자신을 기다리게 되므로 부르지 않는다.
   *
   * mutator 가 던지면 아무것도 쓰지 않고 예외가 그대로 올라간다.
   * 즉 검증 실패는 파일에 흔적을 남기지 않는다.
   */
  async mutate<T>(mutator: (draft: JobDatabase) => Promise<T> | T): Promise<T> {
    return this.mutex.runExclusive(async () => {
      const draft = this.normalize(await this.readRaw());
      const result = await mutator(draft);
      try {
        await this.db.push(ROOT, structuredClone(draft), true);
      } catch (err) {
        // node-json-db 는 메모리를 먼저 바꾸고 그 다음 파일에 쓴다. 쓰기가 실패하면
        // 메모리에만 남아, 이후 읽기가 저장된 적 없는 상태를 보게 된다.
        // 디스크 내용으로 되돌려 "500 을 받았는데 만들어져 있다"는 상태를 막는다.
        try {
          await this.db.reload();
        } catch {
          // 디스크도 못 읽으면 되돌릴 기준이 없다. 원래 오류를 그대로 올린다.
        }
        throw err;
      }
      return result;
    });
  }

  /**
   * 레코드 하나하나의 필드와 타입을 본다. 기동할 때 한 번만 부른다 —
   * 이후 쓰는 것은 전부 이 코드가 만든 값이라 다시 볼 필요가 없다.
   * 최상위 모양만 보고 통과시키면 `title: null` 인 레코드 하나가 검색을 죽이고
   * 처리기의 `attempts += 1` 을 NaN 으로 만든다.
   */
  private validateRecords(db: JobDatabase): void {
    const fail = (where: string, why: string): never => {
      throw new InvalidDataFileError(this.config.dbPath, `${where} ${why}`);
    };
    const seen = new Set<string>();
    db.jobs.forEach((job, index) => {
      const at = `jobs[${index}]`;
      const record = job as unknown as Record<string, unknown>;
      if (
        typeof record !== 'object' ||
        record === null ||
        Array.isArray(record)
      ) {
        fail(at, 'must be an object');
      }
      for (const field of [
        'id',
        'title',
        'description',
        'createdAt',
        'updatedAt',
      ]) {
        if (typeof record[field] !== 'string')
          fail(`${at}.${field}`, 'must be a string');
      }
      if (seen.has(record.id as string)) fail(`${at}.id`, 'is a duplicate');
      seen.add(record.id as string);
      if (
        !(JOB_STATUSES as readonly string[]).includes(record.status as string)
      ) {
        fail(`${at}.status`, `must be one of ${JOB_STATUSES.join(', ')}`);
      }
      if (!Number.isInteger(record.version) || (record.version as number) < 1) {
        fail(`${at}.version`, 'must be an integer >= 1');
      }
      if (
        !Number.isInteger(record.attempts) ||
        (record.attempts as number) < 0
      ) {
        fail(`${at}.attempts`, 'must be an integer >= 0');
      }
      for (const field of ['startedAt', 'finishedAt', 'result', 'error']) {
        if (record[field] !== null && typeof record[field] !== 'string') {
          fail(`${at}.${field}`, 'must be a string or null');
        }
      }
    });
    for (const [key, entry] of Object.entries(db.idempotency)) {
      const record = entry as unknown as Record<string, unknown> | null;
      if (
        typeof record !== 'object' ||
        record === null ||
        typeof record.jobId !== 'string' ||
        typeof record.requestHash !== 'string'
      ) {
        fail(`idempotency["${key}"]`, 'must have string jobId and requestHash');
      }
    }
  }

  private async readRaw(): Promise<unknown> {
    // getData 는 내부 참조를 돌려준다. 여기서 복사해 바깥으로 새지 않게 한다.
    const data = await this.db.getObjectDefault<unknown>(ROOT, emptyDatabase());
    return structuredClone(data);
  }

  /**
   * 파일 내용을 검사해 정해진 모양으로 만든다.
   * 없거나 빈 파일은 새로 시작하고, 내용이 있는데 모양이 다르면 덮어쓰지 않고 거부한다.
   */
  private normalize(data: unknown): JobDatabase {
    if (data === null || data === undefined) return emptyDatabase();
    if (typeof data !== 'object' || Array.isArray(data)) {
      throw new InvalidDataFileError(
        this.config.dbPath,
        'top level must be an object',
      );
    }
    const record = data as Record<string, unknown>;
    if (Object.keys(record).length === 0) return emptyDatabase();
    if (record.jobs !== undefined && !Array.isArray(record.jobs)) {
      throw new InvalidDataFileError(
        this.config.dbPath,
        '"jobs" must be an array',
      );
    }
    const idem = record.idempotency;
    if (
      idem !== undefined &&
      (typeof idem !== 'object' || idem === null || Array.isArray(idem))
    ) {
      throw new InvalidDataFileError(
        this.config.dbPath,
        '"idempotency" must be an object',
      );
    }
    return {
      jobs: (record.jobs as JobDatabase['jobs']) ?? [],
      idempotency: (idem as JobDatabase['idempotency']) ?? {},
    };
  }
}
