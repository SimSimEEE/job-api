import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { createHarness, type Harness } from './harness.js';

describe('Jobs API', () => {
  let h: Harness;
  let server: Server;

  beforeEach(async () => {
    h = await createHarness();
    server = h.app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await h.close();
  });

  const create = (body: Record<string, unknown>) =>
    request(server).post('/jobs').send(body);

  describe('POST /jobs', () => {
    it('작업을 만들고 201 과 Location, ETag 를 준다', async () => {
      const res = await create({
        title: 'Build report',
        description: 'monthly',
      });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        title: 'Build report',
        description: 'monthly',
        status: 'pending',
        version: 1,
        attempts: 0,
        startedAt: null,
        finishedAt: null,
        result: null,
        error: null,
      });
      expect(res.body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(res.headers.location).toBe(`/jobs/${res.body.id}`);
      expect(res.headers.etag).toBe('"1"');
    });

    it('description 은 생략할 수 있고 빈 문자열이 된다', async () => {
      const res = await create({ title: 'No description' });
      expect(res.status).toBe(201);
      expect(res.body.description).toBe('');
    });

    it('공백만인 title 은 400', async () => {
      const res = await create({ title: '   ' });
      expect(res.status).toBe(400);
    });

    it('description 에 null 을 보내면 400 — 생략과 null 은 다르다', async () => {
      const res = await create({ title: 'ok', description: null });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('title 이 없으면 400', async () => {
      const res = await create({ description: 'orphan' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('모르는 필드가 오면 400 — 오타가 조용히 무시되지 않는다', async () => {
      const res = await create({ title: 'ok', stauts: 'pending' });
      expect(res.status).toBe(400);
      expect(res.body.details).toContain('property stauts should not exist');
    });

    it('같은 멱등 키의 재요청은 같은 작업을 돌려준다', async () => {
      const first = await create({ title: 'once' }).set(
        'Idempotency-Key',
        'abc',
      );
      const second = await create({ title: 'once' }).set(
        'Idempotency-Key',
        'abc',
      );

      expect(second.body.id).toBe(first.body.id);
      expect(first.headers['idempotent-replay']).toBe('false');
      expect(second.headers['idempotent-replay']).toBe('true');
      expect(h.readDbFile().jobs).toHaveLength(1);
    });

    it('멱등 키가 너무 길면 400', async () => {
      const res = await create({ title: 'x' }).set(
        'Idempotency-Key',
        'k'.repeat(129),
      );
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_INVALID');
      expect(h.readDbFile().jobs).toHaveLength(0);
    });

    it('재요청은 파일을 다시 쓰지 않는다', async () => {
      await create({ title: 'once' }).set('Idempotency-Key', 'ro');

      const repo = h.repo as unknown as {
        mutate: (...args: unknown[]) => Promise<unknown>;
      };
      const original = repo.mutate.bind(h.repo);
      let writes = 0;
      repo.mutate = (...args) => {
        writes += 1;
        return original(...args);
      };

      const res = await create({ title: 'once' }).set('Idempotency-Key', 'ro');
      expect(res.status).toBe(201);
      expect(res.headers['idempotent-replay']).toBe('true');
      expect(writes).toBe(0);
    });

    it('같은 멱등 키로 다른 본문이 오면 409', async () => {
      await create({ title: 'first' }).set('Idempotency-Key', 'dup');
      const res = await create({ title: 'second' }).set(
        'Idempotency-Key',
        'dup',
      );

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });
  });

  describe('GET /jobs', () => {
    it('페이지 정보와 함께 목록을 준다', async () => {
      for (let i = 0; i < 5; i += 1) await create({ title: `job ${i}` });

      const res = await request(server).get('/jobs?page=2&limit=2');

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.meta).toEqual({
        total: 5,
        page: 2,
        limit: 2,
        totalPages: 3,
      });
    });

    it('limit 상한을 넘기면 400', async () => {
      const res = await request(server).get('/jobs?limit=101');
      expect(res.status).toBe(400);
    });

    it('페이지가 겹치거나 새지 않는다', async () => {
      for (let i = 0; i < 7; i += 1) await create({ title: `p${i}` });

      const seen: string[] = [];
      for (const page of [1, 2, 3]) {
        const res = await request(server).get(`/jobs?page=${page}&limit=3`);
        seen.push(...res.body.data.map((job: { id: string }) => job.id));
      }

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
  });

  describe('GET /jobs/search', () => {
    beforeEach(async () => {
      await create({ title: 'Send Email' });
      await create({ title: 'send sms' });
      await create({ title: 'Generate report' });
    });

    it('제목 부분 일치, 대소문자 무시', async () => {
      const res = await request(server).get('/jobs/search?title=SEND');
      expect(res.body.meta.total).toBe(2);
    });

    it('상태로 거른다', async () => {
      await h.scheduler.runOnce();
      const res = await request(server).get('/jobs/search?status=completed');
      expect(res.body.meta.total).toBe(3);
    });

    it('상태를 여러 개 줄 수 있다', async () => {
      const res = await request(server).get(
        '/jobs/search?status=pending,completed',
      );
      expect(res.body.meta.total).toBe(3);
    });

    it('제목과 상태를 함께 쓰면 둘 다 만족해야 한다', async () => {
      const res = await request(server).get(
        '/jobs/search?title=send&status=pending',
      );
      expect(res.body.meta.total).toBe(2);
    });

    it('알 수 없는 상태값은 400', async () => {
      const res = await request(server).get('/jobs/search?status=banana');
      expect(res.status).toBe(400);
    });

    it("'search' 가 :id 로 잡히지 않는다", async () => {
      // 라우트 선언 순서가 뒤집히면 이 테스트가 400/404 로 깨진다.
      const res = await request(server).get('/jobs/search');
      expect(res.status).toBe(200);
      expect(res.body.meta.total).toBe(3);
    });
  });

  describe('GET /jobs/:id', () => {
    it('단건을 주고 ETag 를 붙인다', async () => {
      const created = await create({ title: 'one' });
      const res = await request(server).get(`/jobs/${created.body.id}`);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(created.body.id);
      expect(res.headers.etag).toBe('"1"');
    });

    it('없는 id 는 404', async () => {
      const res = await request(server).get(
        '/jobs/11111111-1111-4111-8111-111111111111',
      );
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('JOB_NOT_FOUND');
    });

    it('uuid 형식이 아니면 400', async () => {
      const res = await request(server).get('/jobs/nope');
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /jobs/:id', () => {
    it('제목과 설명을 고치고 버전을 올린다', async () => {
      const created = await create({ title: 'before' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: 'after', description: 'edited' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('after');
      expect(res.body.version).toBe(2);
      expect(res.headers.etag).toBe('"2"');
    });

    it('서버가 관리하는 필드는 요청으로 바꿀 수 없다', async () => {
      const created = await create({ title: 'guarded' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ version: 99, attempts: 42, id: 'x' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('title 에 null 을 보내면 400 이고 저장되지 않는다', async () => {
      const created = await create({ title: 'keep me' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: null });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      const job = h.readDbFile().jobs.find((j) => j.id === created.body.id);
      expect(job?.title).toBe('keep me');

      // 이 뒤에 제목 검색이 살아 있어야 한다. null 이 저장됐다면 여기서 500 이 난다.
      const search = await request(server).get('/jobs/search?title=keep');
      expect(search.status).toBe(200);
      expect(search.body.meta.total).toBe(1);
    });

    it('status 에 null 을 보내면 400', async () => {
      const created = await create({ title: 'x' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: null });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });

    it('지금 상태를 그대로 보내면 400 이고 버전이 오르지 않는다', async () => {
      const created = await create({ title: 'same' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'pending' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_UPDATE');
      expect(
        h.readDbFile().jobs.find((j) => j.id === created.body.id)?.version,
      ).toBe(1);
    });

    it('completed 에 completed 를 다시 보내도 400 — 종착 상태는 건드릴 수 없다', async () => {
      const created = await create({ title: 'done' });
      await h.scheduler.runOnce();
      const before = h
        .readDbFile()
        .jobs.find((j) => j.id === created.body.id)!.version;
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'completed' });
      expect(res.status).toBe(400);
      expect(
        h.readDbFile().jobs.find((j) => j.id === created.body.id)?.version,
      ).toBe(before);
    });

    it('같은 값으로 title 을 보내면 400 — 아무것도 바뀌지 않는다', async () => {
      const created = await create({ title: 'unchanged' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: 'unchanged' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_UPDATE');
    });

    it('If-Match 가 숫자도 * 도 아니면 412 가 아니라 400', async () => {
      const created = await create({ title: 'bad tag' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .set('If-Match', 'abc')
        .send({ title: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('IF_MATCH_INVALID');
    });

    it('If-Match: * 는 자원이 있으면 통과한다', async () => {
      const created = await create({ title: 'star' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .set('If-Match', '*')
        .send({ title: 'starred' });
      expect(res.status).toBe(200);
    });

    it('If-Match 가 맞으면 통과한다', async () => {
      const created = await create({ title: 'etag ok' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .set('If-Match', '"1"')
        .send({ title: 'changed' });

      expect(res.status).toBe(200);
    });

    it('If-Match 가 틀리면 412', async () => {
      const created = await create({ title: 'etag stale' });
      await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: 'someone else' });

      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .set('If-Match', '"1"')
        .send({ title: 'too late' });

      expect(res.status).toBe(412);
      expect(res.body.code).toBe('VERSION_CONFLICT');
      expect(res.body.details).toEqual({ expected: '1', actual: 2 });
    });

    it('If-Match 없이 보내면 그대로 통과한다(선택 사항)', async () => {
      const created = await create({ title: 'no precondition' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: 'fine' });
      expect(res.status).toBe(200);
    });

    it('허용되지 않은 상태 전이는 409', async () => {
      const created = await create({ title: 'illegal' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'completed' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('INVALID_STATUS_TRANSITION');
    });

    it('failed 는 pending 으로 되돌릴 수 있고 흔적이 지워진다', async () => {
      const created = await create({ title: 'retry me' });
      // 실패 상태를 만들기 위해 저장소를 직접 바꾼다.
      await h.repo.mutate((draft) => {
        const job = draft.jobs.find((j) => j.id === created.body.id)!;
        job.status = 'failed';
        job.error = 'boom';
        job.finishedAt = new Date().toISOString();
      });

      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'pending' });

      expect(res.status).toBe(200);
      expect(res.body.status).toBe('pending');
      expect(res.body.error).toBeNull();
      expect(res.body.finishedAt).toBeNull();
    });

    it('빈 본문은 400 이고 버전이 오르지 않는다', async () => {
      const created = await create({ title: 'no-op' });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('EMPTY_UPDATE');
      expect(
        h.readDbFile().jobs.find((j) => j.id === created.body.id)?.version,
      ).toBe(1);
    });

    it('실행 중인 작업의 내용은 고칠 수 없다', async () => {
      const created = await create({ title: 'in flight' });
      await h.repo.mutate((draft) => {
        draft.jobs.find((j) => j.id === created.body.id)!.status = 'processing';
      });
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ title: 'sneaky edit' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTENT_NOT_EDITABLE');
    });

    it('완료된 작업의 내용은 고칠 수 없다', async () => {
      const created = await create({ title: 'done' });
      await h.scheduler.runOnce();
      const res = await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ description: 'rewrite history' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('CONTENT_NOT_EDITABLE');
    });

    it('검증에 실패한 요청은 파일에 흔적을 남기지 않는다', async () => {
      const created = await create({ title: 'untouched' });
      await request(server)
        .patch(`/jobs/${created.body.id}`)
        .send({ status: 'completed' });

      const job = h.readDbFile().jobs.find((j) => j.id === created.body.id);
      expect(job?.version).toBe(1);
      expect(job?.status).toBe('pending');
    });
  });

  describe('오류 응답 형식', () => {
    it('모든 오류가 같은 모양이다', async () => {
      const cases = await Promise.all([
        request(server).get('/jobs/nope'),
        request(server).get('/jobs/11111111-1111-4111-8111-111111111111'),
        request(server).post('/jobs').send({}),
        request(server).get('/does-not-exist'),
      ]);

      for (const res of cases) {
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.body).toHaveProperty('statusCode', res.status);
        expect(typeof res.body.code).toBe('string');
        expect(typeof res.body.message).toBe('string');
        expect(typeof res.body.path).toBe('string');
        expect(typeof res.body.timestamp).toBe('string');
        expect(typeof res.body.requestId).toBe('string');
      }
    });

    it('본문이 너무 크면 500 이 아니라 413 이고 모양이 같다', async () => {
      const res = await request(server)
        .post('/jobs')
        .send({ title: 'x'.repeat(200 * 1024) });
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
      expect(typeof res.body.requestId).toBe('string');
    });

    it('JSON 이 깨진 본문은 400', async () => {
      const res = await request(server)
        .post('/jobs')
        .set('Content-Type', 'application/json')
        .send('{"title": ');
      expect(res.status).toBe(400);
      expect(typeof res.body.code).toBe('string');
    });

    it('응답의 x-request-id 와 본문의 requestId 가 같다', async () => {
      const res = await request(server).get('/jobs/nope');
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    });

    it('클라이언트가 보낸 x-request-id 를 이어 쓴다', async () => {
      const res = await request(server)
        .get('/jobs')
        .set('x-request-id', 'trace-me');
      expect(res.headers['x-request-id']).toBe('trace-me');
    });

    it('형식에 맞지 않는 x-request-id 는 버리고 새로 만든다', async () => {
      const res = await request(server)
        .get('/jobs')
        .set('x-request-id', 'bad id with spaces');
      expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
      expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    });
  });
});
