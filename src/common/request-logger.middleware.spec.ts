import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextFunction, Request, Response } from 'express';
import type { FileLoggerService, LogEntry } from './file-logger.service.js';
import { RequestLoggerMiddleware } from './request-logger.middleware.js';

/**
 * 실서버로는 중단 경로를 재현하기 어렵다 — 모든 엔드포인트가 1ms 안에 응답해서
 * 소켓을 끊기 전에 finish 가 먼저 온다. 여기서는 응답 객체를 흉내 내어
 * finish 없이 close 만 오는 경우를 직접 만든다.
 */
const build = () => {
  const lines: LogEntry[] = [];
  const logger = {
    log: (e: LogEntry) => lines.push(e),
  } as unknown as FileLoggerService;
  const mw = new RequestLoggerMiddleware(logger);

  const headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
    getHeader: () => undefined,
  }) as unknown as Response;

  const run = (reqHeaders: Record<string, string> = {}) => {
    const req = {
      headers: reqHeaders,
      method: 'GET',
      originalUrl: '/jobs',
    } as unknown as Request;
    const next = (() => {}) as NextFunction;
    mw.use(req, res, next);
    return { req, res, lines, headers };
  };
  return run;
};

describe('RequestLoggerMiddleware', () => {
  it('정상 완료: finish 뒤에 close 가 와도 한 줄만 남는다', () => {
    const { res, lines } = build()();
    res.emit('finish');
    res.emit('close');
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('request.finished');
  });

  it('클라이언트가 끊음: finish 없이 close 만 오면 aborted 로 남는다', () => {
    const { res, lines } = build()();
    res.emit('close');
    expect(lines).toHaveLength(1);
    expect(lines[0].event).toBe('request.aborted');
    expect(lines[0].path).toBe('/jobs');
  });

  it('형식에 맞는 X-Request-Id 는 그대로 쓴다', () => {
    const { req, headers } = build()({ 'x-request-id': 'trace-1.a_b' });
    expect(req.requestId).toBe('trace-1.a_b');
    expect(headers['x-request-id']).toBe('trace-1.a_b');
  });

  it('형식에 맞지 않는 X-Request-Id 는 버리고 새로 만든다', () => {
    for (const bad of ['has space', 'line\nbreak', 'x'.repeat(129), '']) {
      const { req } = build()({ 'x-request-id': bad });
      expect(req.requestId).not.toBe(bad);
      expect(req.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
