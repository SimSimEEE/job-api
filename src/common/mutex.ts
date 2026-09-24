/**
 * 하나의 비동기 임계 구역을 FIFO 로 직렬화하는 뮤텍스.
 *
 * 왜 직접 만들었나:
 *   `async-mutex` 같은 라이브러리로 대체할 수 있고 실무라면 그렇게 했을 것이다.
 *   여기서는 직렬화가 이 시스템의 핵심 장치라 동작을 드러내 두는 쪽을 택했다.
 *
 * 왜 필요한가:
 *   node-json-db 는 호출 하나하나(getData / push)를 내부 read-write 잠금으로
 *   이미 직렬화한다. 하지만 "읽고 → 고치고 → 쓰기"는 호출 두 번이라
 *   그 사이에 다른 쓰기가 끼어들 수 있고, 먼저 읽은 쪽이 나중에 덮어쓰면
 *   갱신 손실(lost update)이 난다. 이 뮤텍스는 그 연속 동작 전체를 하나의
 *   임계 구역으로 묶는다.
 *
 * 잠금 순서:
 *   항상 이 뮤텍스를 먼저 잡고 그 안에서 node-json-db 를 호출한다.
 *   반대 방향으로 잡는 경로가 없으므로 교착은 생기지 않는다.
 */
export class Mutex {
  /** 잠금을 기다리는 순서대로 쌓이는 대기열. 앞에서부터 꺼내 FIFO 를 보장한다. */
  private readonly waiters: Array<() => void> = [];
  private locked = false;

  /** 대기 중인 작업 수. 테스트에서 경합이 실제로 일어났는지 확인하는 용도. */
  get pending(): number {
    return this.waiters.length;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /**
   * fn 을 임계 구역 안에서 실행한다.
   * fn 이 던지더라도 잠금은 반드시 풀리므로 뒤에 선 대기자가 막히지 않는다.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // locked 를 true 로 유지한 채 소유권만 넘긴다.
      // 여기서 false 로 되돌리면 대기자가 깨어나기 전에 들어온 새 요청이
      // 새치기해서 FIFO 가 깨진다.
      next();
      return;
    }
    this.locked = false;
  }
}
