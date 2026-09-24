import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { JsonDB, Config as JsonDbConfig } from 'node-json-db';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';
import { Mutex } from '../common/mutex.js';
import { emptyDatabase, type Job, type JobDatabase } from './job.entity.js';

const ROOT = '/';

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
    await this.mutex.runExclusive(async () => {
      const current = await this.readRaw();
      await this.db.push(ROOT, this.normalize(current), true);
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
      await this.db.push(ROOT, structuredClone(draft), true);
      return result;
    });
  }

  private async readRaw(): Promise<Partial<JobDatabase> | null> {
    // getData 는 내부 참조를 돌려준다. 여기서 복사해 바깥으로 새지 않게 한다.
    const data = await this.db.getObjectDefault<Partial<JobDatabase>>(
      ROOT,
      emptyDatabase(),
    );
    return structuredClone(data);
  }

  /** 손으로 편집된 파일이나 예전 형식도 받아 주기 위한 보정. */
  private normalize(data: Partial<JobDatabase> | null): JobDatabase {
    return {
      jobs: Array.isArray(data?.jobs) ? data.jobs : [],
      idempotency:
        data?.idempotency && typeof data.idempotency === 'object'
          ? data.idempotency
          : {},
    };
  }
}
