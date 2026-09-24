import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import {
  FileLoggerService,
  type LogEntry,
} from '../common/file-logger.service.js';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';
import type { Job } from './job.entity.js';
import { JobsRepository, UNCHANGED } from './jobs.repository.js';

const INTERVAL_NAME = 'job-processing';

export interface TickReport {
  /** 이번 주기에 집어간 작업 수 */
  claimed: number;
  completed: number;
  failed: number;
  /** 방치된 processing 을 pending 으로 되돌린 수 */
  recovered: number;
  /** 앞선 주기가 아직 끝나지 않아 건너뛴 경우 true */
  skipped: boolean;
  durationMs: number;
}

/**
 * 대기 중인 작업을 주기적으로 처리하는 백그라운드 처리기.
 *
 * 한 주기는 세 단계로 나뉜다. 이 분리가 이 클래스의 핵심이다.
 *
 *   1) 집어가기(claim) — 임계 구역 안. pending 을 골라 processing 으로 바꾸고 한 번 저장한다.
 *   2) 처리(work)      — 임계 구역 밖. 실제 일을 한다.
 *   3) 마무리(settle)  — 임계 구역 안. 결과에 따라 completed / failed 로 바꾼다.
 *
 * 왜 처리를 임계 구역 밖에 두는가:
 *   일이 오래 걸릴 수 있는데 그 동안 잠금을 쥐고 있으면 모든 API 요청이 같이 멈춘다.
 *   상태를 바꾸는 짧은 순간만 잠그고, 긴 작업은 잠금 없이 한다.
 *   집어가는 순간 이미 processing 으로 표시했으므로,
 *   처리 중에 다른 주기나 요청이 같은 작업을 다시 집어갈 수 없다.
 */
@Injectable()
export class JobsScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsScheduler.name);

  /**
   * 앞선 주기가 아직 돌고 있는지 나타내는 표시.
   *
   * 이 표시가 중복 처리를 막는 것은 아니다. 중복은 집어가기가 임계 구역 안에서
   * processing 으로 바꾸는 것으로 이미 막혀 있다 — 겹친 주기가 와도 같은 작업을
   * 두 번 집어갈 수는 없다.
   *
   * 이 표시가 하는 일은 동시에 도는 주기를 하나로 제한하는 것이다. 처리가 주기보다
   * 오래 걸리면 주기마다 새 실행이 쌓여 각각 배치 크기만큼 집어가고, 그러면
   * 배치 크기가 "한 번에 이만큼"이라는 뜻을 잃는다. 겹치는 실행은 건너뛴다.
   */
  private running = false;

  constructor(
    private readonly repo: JobsRepository,
    private readonly fileLogger: FileLoggerService,
    private readonly registry: SchedulerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    if (!this.config.schedulerEnabled) {
      this.logger.log('스케줄러가 비활성화되어 등록하지 않습니다.');
      return;
    }
    // 주기를 환경변수로 바꿀 수 있어야 하므로 @Interval 데코레이터(상수) 대신
    // SchedulerRegistry 에 실행 시점에 등록한다.
    const interval = setInterval(() => {
      // runOnce 는 실패를 scheduler.tick_failed 로 기록한 뒤 다시 던진다(테스트가 그 동작을 본다).
      // 여기서 받지 않으면 unhandled rejection 이 되고, Node 는 그것으로 프로세스를 내린다.
      // 백그라운드 주기의 디스크 오류 한 번이 API 까지 죽여서는 안 된다.
      this.runOnce().catch(() => undefined);
    }, this.config.schedulerIntervalMs);
    this.registry.addInterval(INTERVAL_NAME, interval);
    this.logger.log(
      `스케줄러 등록: ${this.config.schedulerIntervalMs}ms 주기, 한 번에 최대 ${this.config.schedulerBatchSize}건`,
    );
  }

  onModuleDestroy(): void {
    if (this.registry.doesExist('interval', INTERVAL_NAME)) {
      this.registry.deleteInterval(INTERVAL_NAME);
    }
  }

  /** 한 주기를 실행한다. 테스트에서는 이 메서드를 직접 부른다. */
  async runOnce(): Promise<TickReport> {
    const startedAt = Date.now();

    if (this.running) {
      const report: TickReport = {
        claimed: 0,
        completed: 0,
        failed: 0,
        recovered: 0,
        skipped: true,
        durationMs: 0,
      };
      this.report(report);
      return report;
    }
    this.running = true;

    try {
      const { claimed, recovered } = await this.claim();

      let completed = 0;
      let failed = 0;

      for (const job of claimed) {
        const outcome = await this.work(job);
        // 집어갈 때의 attempts 를 토큰으로 넘긴다. settle 이 "내가 집어간 그 실행"인지 확인한다.
        const settled = await this.settle(job.id, job.attempts, outcome);
        if (settled === 'completed') completed += 1;
        else if (settled === 'failed') failed += 1;
      }

      const report: TickReport = {
        claimed: claimed.length,
        completed,
        failed,
        recovered,
        skipped: false,
        durationMs: Date.now() - startedAt,
      };
      this.report(report);
      return report;
    } catch (error) {
      this.fileLogger.log({
        channel: 'scheduler',
        event: 'scheduler.tick_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.running = false;
    }
  }

  /**
   * 1단계. 임계 구역 안에서 처리 대상을 확정한다.
   *
   * 방치된 processing 회수를 같은 임계 구역에서 함께 하는 이유는,
   * 회수하고 집어가는 사이에 다른 주기가 끼어들면 회수된 작업을 두 번
   * 집어갈 수 있기 때문이다.
   */
  private async claim(): Promise<{ claimed: Job[]; recovered: number }> {
    // 로그는 저장이 끝난 뒤에 남긴다. mutator 안에서 바로 쓰면 저장이 실패했을 때
    // 일어나지 않은 처리가 logs.txt 에 기록된다. 대신 저장 뒤 로그 전에 프로세스가
    // 죽으면 그 로그는 잃는다 — 파일이 사실이고 로그는 그 기록이라 이쪽을 택했다.
    const entries: LogEntry[] = [];
    const result = await this.repo.mutate((draft) => {
      const now = Date.now();
      let recovered = 0;

      for (const job of draft.jobs) {
        if (job.status !== 'processing') continue;
        const startedAt = job.startedAt ? Date.parse(job.startedAt) : 0;
        if (now - startedAt <= this.config.staleProcessingMs) continue;

        // 처리 도중 프로세스가 죽어 processing 에 갇힌 작업을 되돌린다.
        job.status = 'pending';
        job.startedAt = null;
        job.version += 1;
        job.updatedAt = new Date().toISOString();
        recovered += 1;
        entries.push({
          channel: 'scheduler',
          event: 'job.recovered',
          jobId: job.id,
        });
      }

      const targets = draft.jobs
        .filter((job) => job.status === 'pending')
        .slice(0, this.config.schedulerBatchSize);

      const nowIso = new Date().toISOString();
      for (const job of targets) {
        job.status = 'processing';
        job.attempts += 1;
        job.startedAt = nowIso;
        job.error = null;
        job.version += 1;
        job.updatedAt = nowIso;
        entries.push({
          channel: 'scheduler',
          event: 'job.claimed',
          jobId: job.id,
          attempt: job.attempts,
        });
      }

      // 회수한 것도 집어간 것도 없으면 쓰지 않는다. 판단은 임계 구역 안에서 그대로 했다.
      if (recovered === 0 && targets.length === 0) return UNCHANGED;
      return { claimed: structuredClone(targets), recovered };
    });
    for (const entry of entries) this.fileLogger.log(entry);
    return result === UNCHANGED ? { claimed: [], recovered: 0 } : result;
  }

  /**
   * 2단계. 실제 처리. 잠금을 쥐지 않는다.
   *
   * 여기에 붙을 것이 원래는 외부 호출이나 무거운 계산이다.
   * 지금은 지연과 확률적 실패로 흉내만 낸다.
   */
  private async work(job: Job): Promise<{ ok: boolean; detail: string }> {
    if (this.config.workDurationMs > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.config.workDurationMs),
      );
    }
    if (Math.random() < this.config.failureRate) {
      return { ok: false, detail: 'Simulated processing failure.' };
    }
    return { ok: true, detail: `Processed '${job.title}'.` };
  }

  /**
   * 3단계. 임계 구역 안에서 결과를 기록한다.
   *
   * 상태가 processing 인지만 보면 부족하다. 2단계 동안 이 작업이 방치된 것으로
   * 회수되고 다른 실행이 다시 집어갔다면, 상태는 여전히 processing 이지만
   * 그건 남의 실행이다. 거기에 내 결과를 쓰면 남의 실행을 덮어쓴다.
   * 그래서 집어갈 때의 attempts 를 토큰으로 받아 같은지 확인한다.
   * 회수가 attempts 를 바꾸지는 않지만 다시 집어가는 순간 +1 되므로 구분된다.
   */
  private async settle(
    jobId: string,
    claimedAttempts: number,
    outcome: { ok: boolean; detail: string },
  ): Promise<'completed' | 'failed' | 'skipped'> {
    const entries: LogEntry[] = [];
    const result = await this.repo.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === jobId);
      const reason = !job
        ? 'job no longer exists'
        : job.status !== 'processing'
          ? `status is '${job.status}'`
          : job.attempts !== claimedAttempts
            ? `claimed at attempt ${claimedAttempts}, now at ${job.attempts}`
            : null;
      if (!job || reason) {
        entries.push({
          channel: 'scheduler',
          event: 'job.settle_skipped',
          jobId,
          reason,
        });
        return UNCHANGED;
      }

      const nowIso = new Date().toISOString();
      job.status = outcome.ok ? 'completed' : 'failed';
      job.result = outcome.ok ? outcome.detail : null;
      job.error = outcome.ok ? null : outcome.detail;
      job.finishedAt = nowIso;
      job.version += 1;
      job.updatedAt = nowIso;

      entries.push({
        channel: 'scheduler',
        event: outcome.ok ? 'job.completed' : 'job.failed',
        jobId,
        attempt: job.attempts,
        detail: outcome.detail,
      });

      return job.status;
    });
    for (const entry of entries) this.fileLogger.log(entry);
    return result === UNCHANGED ? 'skipped' : result;
  }

  private report(report: TickReport): void {
    this.fileLogger.log({
      channel: 'scheduler',
      event: 'scheduler.tick',
      ...report,
    });
    if (report.skipped) {
      this.logger.warn('앞선 주기가 아직 끝나지 않아 이번 주기를 건너뜁니다.');
    }
  }
}
