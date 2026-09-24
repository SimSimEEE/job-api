import { Injectable, type NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { FileLoggerService } from './file-logger.service.js';

/** 요청별 상관관계 ID. 오류 응답 본문에도 같은 값이 들어간다. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * 클라이언트가 보낸 ID 를 받아 주되 형식은 제한한다.
 * 그대로 쓰면 로그 한 줄에 임의 길이 문자열이 들어가고, 줄바꿈 같은 것이 섞이면
 * 한 줄 = 한 JSON 이라는 전제가 깨진다.
 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

declare module 'express-serve-static-core' {
  interface Request {
    requestId?: string;
  }
}

/**
 * 모든 요청을 logs.txt 에 남긴다.
 *
 * 인터셉터가 아니라 미들웨어를 쓴 이유:
 *   인터셉터는 라우트에 매칭된 요청에만 걸린다. 존재하지 않는 경로로 온 404 는
 *   기록되지 않는다. 미들웨어는 매칭 여부와 무관하게 모든 요청을 거치고,
 *   응답의 'finish' 이벤트에서 최종 상태 코드와 소요 시간을 얻을 수 있다.
 *   클라이언트가 중간에 끊으면 'finish' 없이 'close' 만 오므로 그 경우도 기록한다.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(private readonly fileLogger: FileLoggerService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers[REQUEST_ID_HEADER];
    const requestId =
      typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
        ? incoming
        : randomUUID();
    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const startedAt = process.hrtime.bigint();
    let logged = false;

    const write = (event: 'request.finished' | 'request.aborted') => {
      if (logged) return;
      logged = true;
      const durationMs =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      this.fileLogger.log({
        channel: 'http',
        event,
        requestId,
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: Number(durationMs.toFixed(3)),
        // 본문 전체는 남기지 않는다. 개인정보가 섞일 수 있고 로그가 금방 커진다.
        contentLength: Number(res.getHeader('content-length') ?? 0),
      });
    };

    res.on('finish', () => write('request.finished'));
    res.on('close', () => write('request.aborted'));

    next();
  }
}
