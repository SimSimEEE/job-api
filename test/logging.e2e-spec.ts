import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { createHarness, type Harness } from './harness.js';

describe('logs.txt 기록', () => {
  let h: Harness;
  let server: Server;

  beforeEach(async () => {
    h = await createHarness();
    server = h.app.getHttpServer() as Server;
  });

  afterEach(async () => {
    await h.close();
  });

  it('모든 줄이 하나의 JSON 이다', async () => {
    await request(server).post('/jobs').send({ title: 'logged' });
    await request(server).get('/jobs');
    await h.scheduler.runOnce();
    await h.logger.flush();

    const lines = h.readLogLines();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(typeof line.timestamp).toBe('string');
      expect(['http', 'scheduler']).toContain(line.channel);
    }
  });

  it('요청 하나당 http 줄 하나', async () => {
    await request(server).get('/jobs');
    await request(server).get('/jobs');
    await request(server).get('/jobs');
    await h.logger.flush();

    const http = h
      .readLogLines()
      .filter((line) => line.channel === 'http' && line.path === '/jobs');
    expect(http).toHaveLength(3);
  });

  it('메서드·경로·상태코드·소요시간을 남긴다', async () => {
    await request(server).post('/jobs').send({ title: 'detail' });
    await h.logger.flush();

    const entry = h
      .readLogLines()
      .find((line) => line.channel === 'http' && line.method === 'POST');

    expect(entry).toMatchObject({
      method: 'POST',
      path: '/jobs',
      statusCode: 201,
    });
    expect(typeof entry?.durationMs).toBe('number');
    expect(typeof entry?.requestId).toBe('string');
  });

  it('실패한 요청도 남는다', async () => {
    await request(server).post('/jobs').send({});
    await request(server).get('/jobs/11111111-1111-4111-8111-111111111111');
    await h.logger.flush();

    const codes = h
      .readLogLines()
      .filter((line) => line.channel === 'http')
      .map((line) => line.statusCode);

    expect(codes).toContain(400);
    expect(codes).toContain(404);
  });

  it('본문 파서가 거부한 요청(413)도 남는다', async () => {
    await request(server)
      .post('/jobs')
      .send({ title: 'x'.repeat(200 * 1024) });
    await h.logger.flush();
    const entry = h.readLogLines().find((line) => line.statusCode === 413);
    expect(entry).toMatchObject({
      channel: 'http',
      method: 'POST',
      path: '/jobs',
    });
    expect(typeof entry?.requestId).toBe('string');
  });

  it('라우트에 잡히지 않은 요청도 남는다', async () => {
    // 인터셉터 대신 미들웨어를 쓴 이유가 이것이다.
    await request(server).get('/no-such-route');
    await h.logger.flush();

    const entry = h
      .readLogLines()
      .find((line) => line.path === '/no-such-route');

    expect(entry).toMatchObject({ channel: 'http', statusCode: 404 });
  });

  it('스케줄러 처리 결과를 남긴다', async () => {
    await request(server).post('/jobs').send({ title: 'to process' });
    await h.scheduler.runOnce();
    await h.logger.flush();

    const events = h
      .readLogLines()
      .filter((line) => line.channel === 'scheduler')
      .map((line) => line.event);

    expect(events).toContain('job.claimed');
    expect(events).toContain('job.completed');
    expect(events).toContain('scheduler.tick');
  });

  it('주기 요약에 처리 건수가 들어간다', async () => {
    for (let i = 0; i < 3; i += 1) {
      await request(server)
        .post('/jobs')
        .send({ title: `t${i}` });
    }
    await h.scheduler.runOnce();
    await h.logger.flush();

    const tick = h
      .readLogLines()
      .find(
        (line) =>
          line.channel === 'scheduler' && line.event === 'scheduler.tick',
      );

    expect(tick).toMatchObject({ claimed: 3, completed: 3, failed: 0 });
  });

  it('동시 요청에서도 줄이 섞이지 않는다', async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        request(server)
          .post('/jobs')
          .send({ title: `concurrent ${i}` }),
      ),
    );
    await h.logger.flush();

    // 한 줄이라도 깨졌으면 readLogLines 의 JSON.parse 가 던진다.
    const http = h
      .readLogLines()
      .filter((line) => line.channel === 'http' && line.method === 'POST');
    expect(http).toHaveLength(50);
  });
});
