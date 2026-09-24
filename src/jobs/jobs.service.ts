import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  ContentNotEditableException,
  EmptyUpdateException,
  IdempotencyKeyReuseException,
  InvalidIdempotencyKeyException,
  InvalidIfMatchException,
  InvalidTransitionException,
  JobNotFoundException,
  VersionConflictException,
} from '../common/errors.js';
import type { CreateJobDto } from './dto/create-job.dto.js';
import type {
  SearchJobsQueryDto,
  PaginationQueryDto,
} from './dto/search-jobs.dto.js';
import type { UpdateJobDto } from './dto/update-job.dto.js';
import type { Job, JobDatabase, JobStatus } from './job.entity.js';
import {
  canClientTransition,
  clientTransitionsFrom,
  isContentEditable,
} from './job.transitions.js';
import { JobsRepository } from './jobs.repository.js';

export interface Page<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface CreateResult {
  job: Job;
  /** 같은 멱등 키로 이미 만들어진 작업을 되돌려준 경우 true. */
  replayed: boolean;
}

@Injectable()
export class JobsService {
  constructor(private readonly repo: JobsRepository) {}

  /**
   * 작업 생성.
   *
   * Idempotency-Key 헤더가 있으면 같은 키의 재요청을 처음 결과로 수렴시킨다.
   * 꼭 있어야 하는 기능은 아니지만, 작업을 만드는 엔드포인트에서 네트워크 재시도가
   * 중복 작업으로 바뀌는 것은 실제로 자주 겪는 문제라 넣었다.
   *
   * 키 조회와 생성이 같은 임계 구역 안에 있는 것이 핵심이다.
   * 조회를 먼저 하고 나중에 따로 생성하면, 동시에 들어온 두 요청이
   * 둘 다 "아직 없다"를 읽고 둘 다 만들어 버린다.
   */
  async create(
    dto: CreateJobDto,
    idempotencyKey?: string,
  ): Promise<CreateResult> {
    if (idempotencyKey !== undefined) {
      this.assertValidIdempotencyKey(idempotencyKey);
    }
    const requestHash = this.hashRequest(dto);

    if (idempotencyKey) {
      // 재요청은 잠금 밖에서 먼저 확인한다. 키가 있으면 읽기만으로 끝나고 파일을
      // 다시 쓰지 않는다. 없으면 임계 구역으로 들어가 다시 확인한다 — 여기서
      // 못 본 사이에 다른 요청이 만들었을 수 있다.
      const replay = this.replayFor(
        await this.repo.snapshot(),
        idempotencyKey,
        requestHash,
      );
      if (replay) return replay;
    }

    return this.repo.mutate((draft) => {
      if (idempotencyKey) {
        const replay = this.replayFor(draft, idempotencyKey, requestHash);
        if (replay) return replay;
      }

      const now = new Date().toISOString();
      const job: Job = {
        id: randomUUID(),
        title: dto.title,
        description: dto.description ?? '',
        status: 'pending',
        version: 1,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      };
      draft.jobs.push(job);

      if (idempotencyKey) {
        draft.idempotency[idempotencyKey] = {
          jobId: job.id,
          requestHash,
          createdAt: now,
        };
      }

      return { job: structuredClone(job), replayed: false };
    });
  }

  async findAll(query: PaginationQueryDto): Promise<Page<Job>> {
    const { jobs } = await this.repo.snapshot();
    return this.paginate(this.sort(jobs), query);
  }

  async search(query: SearchJobsQueryDto): Promise<Page<Job>> {
    const { jobs } = await this.repo.snapshot();
    const needle = query.title?.toLowerCase();

    const filtered = jobs.filter((job) => {
      if (needle && !job.title.toLowerCase().includes(needle)) return false;
      if (query.status?.length && !query.status.includes(job.status))
        return false;
      return true;
    });

    return this.paginate(this.sort(filtered), query);
  }

  async findOne(id: string): Promise<Job> {
    const job = await this.repo.findById(id);
    if (!job) throw new JobNotFoundException(id);
    return job;
  }

  /**
   * 작업 수정.
   *
   * ifMatch 가 있으면 읽은 시점의 버전과 현재 버전을 비교한다.
   * 뮤텍스는 이 프로세스 안의 동시 쓰기를 막아 주지만,
   * 클라이언트가 GET 으로 읽고 PATCH 를 보내는 사이의 변경은 별개의 문제다.
   * 그 구간은 버전 비교로만 잡을 수 있다.
   */
  async update(id: string, dto: UpdateJobDto, ifMatch?: string): Promise<Job> {
    return this.repo.mutate((draft) => {
      const job = draft.jobs.find((candidate) => candidate.id === id);
      if (!job) throw new JobNotFoundException(id);

      if (
        dto.title === undefined &&
        dto.description === undefined &&
        dto.status === undefined
      ) {
        throw new EmptyUpdateException();
      }

      if (ifMatch !== undefined) {
        const tags = this.parseIfMatch(ifMatch);
        if (!tags.some((tag) => tag === '*' || tag === String(job.version))) {
          throw new VersionConflictException(tags.join(', '), job.version);
        }
      }

      // 바뀔 결과를 먼저 만들고, 현재와 비교해서 실제로 달라지는 것만 쓴다.
      const next: Job = { ...job };
      if (dto.title !== undefined) next.title = dto.title;
      if (dto.description !== undefined) next.description = dto.description;

      const contentChanges =
        next.title !== job.title || next.description !== job.description;
      if (contentChanges && !isContentEditable(job.status)) {
        throw new ContentNotEditableException(job.status);
      }

      // 지금 상태를 그대로 보내는 것은 전이가 아니다. 검사도, 쓰기도 하지 않는다.
      const statusChanges =
        dto.status !== undefined && dto.status !== job.status;
      if (statusChanges) {
        const to = dto.status as JobStatus;
        if (!canClientTransition(job.status, to)) {
          throw new InvalidTransitionException(
            job.status,
            to,
            clientTransitionsFrom(job.status),
          );
        }
        // failed → pending 재투입. 지난 실행의 흔적을 지워 깨끗한 상태로 되돌린다.
        next.status = to;
        next.startedAt = null;
        next.finishedAt = null;
        next.error = null;
        next.result = null;
      }

      // 결과가 현재와 같으면 쓰지 않는다. 버전만 올리고 ETag 를 무효화하는 것을 막는다.
      if (!contentChanges && !statusChanges) throw new EmptyUpdateException();

      next.version = job.version + 1;
      next.updatedAt = new Date().toISOString();
      Object.assign(job, next);
      return structuredClone(job);
    });
  }

  /**
   * RFC 9110 의 If-Match.
   * 값은 쉼표로 여러 개 올 수 있고, "*" 는 자원이 존재하기만 하면 일치한다.
   * 약한 검증자 표시(W/)와 따옴표는 벗기고 버전 숫자와 비교한다.
   */
  private parseIfMatch(ifMatch: string): string[] {
    const tags = ifMatch
      .split(',')
      .map((tag) => tag.trim().replace(/^W\//, '').replace(/^"|"$/g, ''));
    // 버전은 숫자다. 숫자도 "*" 도 아닌 값은 "안 맞는 버전"이 아니라 잘못된 요청이다.
    const bad = tags.find((tag) => tag !== '*' && !/^\d+$/.test(tag));
    if (bad !== undefined) throw new InvalidIfMatchException(ifMatch);
    return tags;
  }

  /**
   * 같은 멱등 키의 기록이 있으면 그 작업을 돌려주고, 없으면 null.
   * 같은 키에 다른 본문이면 던진다. 기록은 있는데 작업이 지워졌으면 null 로 새로 만들게 한다.
   */
  private replayFor(
    db: JobDatabase,
    key: string,
    requestHash: string,
  ): CreateResult | null {
    const seen = db.idempotency[key];
    if (!seen) return null;
    if (seen.requestHash !== requestHash) {
      throw new IdempotencyKeyReuseException(key);
    }
    const existing = db.jobs.find((job) => job.id === seen.jobId);
    return existing ? { job: structuredClone(existing), replayed: true } : null;
  }

  /**
   * 키 길이 상한. 키는 파일에 영구 저장되므로 상한이 없으면 키 하나로 파일을 부풀릴 수 있다.
   * 인증이 없어 키의 범위는 전역이다 — 두 클라이언트가 같은 키를 쓰면 서로의 결과를 본다.
   */
  private static readonly IDEMPOTENCY_KEY_MAX = 128;

  private assertValidIdempotencyKey(key: string): void {
    if (key.trim() === '') {
      throw new InvalidIdempotencyKeyException('must not be blank');
    }

    if (key.length > JobsService.IDEMPOTENCY_KEY_MAX) {
      throw new InvalidIdempotencyKeyException(
        `must be at most ${JobsService.IDEMPOTENCY_KEY_MAX} characters`,
      );
    }
  }

  private hashRequest(dto: CreateJobDto): string {
    const canonical = JSON.stringify({
      title: dto.title,
      description: dto.description ?? '',
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  /**
   * 최신순. 생성 시각이 같으면 id 로 순서를 확정한다.
   * 같은 값에서 순서가 흔들리면 페이지 경계에서 항목이 새거나 겹친다.
   */
  private sort(jobs: Job[]): Job[] {
    return [...jobs].sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? -1 : 1;
    });
  }

  private paginate(jobs: Job[], query: PaginationQueryDto): Page<Job> {
    const total = jobs.length;
    const start = (query.page - 1) * query.limit;
    return {
      data: jobs.slice(start, start + query.limit),
      meta: {
        total,
        page: query.page,
        limit: query.limit,
        totalPages: Math.ceil(total / query.limit) || 0,
      },
    };
  }
}

export type { JobDatabase };
