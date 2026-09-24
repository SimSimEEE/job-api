import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';

export interface ErrorResponseBody {
  statusCode: number;
  /** 클라이언트가 분기에 쓸 수 있는 안정적인 식별자 */
  code: string;
  message: string;
  details?: unknown;
  path: string;
  requestId?: string;
  timestamp: string;
}

/**
 * 모든 오류 응답의 모양을 하나로 맞춘다.
 *
 * Nest 기본 예외(NotFoundException 등)와 ValidationPipe 의 400,
 * 직접 정의한 도메인 예외, 그리고 예상 못 한 예외까지 전부 같은 본문으로 나간다.
 * 클라이언트 입장에서 오류 처리 코드를 한 벌만 쓰면 되도록 하는 것이 목적이다.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const body = this.toBody(exception, req);

    if (body.statusCode >= HttpStatus.INTERNAL_SERVER_ERROR) {
      // 예상 못 한 오류만 스택을 남긴다. 4xx 까지 남기면 신호가 묻힌다.
      this.logger.error(
        `${req.method} ${req.originalUrl} -> ${body.statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    res.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown, req: Request): ErrorResponseBody {
    const { statusCode, code, message, details } = this.classify(exception);
    // 필드 순서를 고정한다. 응답을 눈으로 읽을 때 무엇이 났는지가 먼저 보여야 한다.
    return {
      statusCode,
      code,
      message,
      ...(details === undefined ? {} : { details }),
      path: req.originalUrl,
      requestId: req.requestId,
      timestamp: new Date().toISOString(),
    };
  }

  private classify(exception: unknown): {
    statusCode: number;
    code: string;
    message: string;
    details?: unknown;
  } {
    if (!(exception instanceof HttpException)) {
      return {
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        code: 'INTERNAL_ERROR',
        // 내부 예외 메시지를 그대로 내보내지 않는다. 구현 내부가 드러날 수 있다.
        message: 'Unexpected internal error.',
      };
    }

    const statusCode = exception.getStatus();
    const payload = exception.getResponse();

    if (typeof payload === 'string') {
      return {
        statusCode,
        code: this.fallbackCode(statusCode),
        message: payload,
      };
    }

    const record = payload as Record<string, unknown>;
    const rawMessage = record.message;
    // ValidationPipe 는 message 를 문자열 배열로 준다. 그 경우 details 로 옮긴다.
    const isFieldErrors = Array.isArray(rawMessage);

    return {
      statusCode,
      code:
        typeof record.code === 'string'
          ? record.code
          : isFieldErrors
            ? 'VALIDATION_FAILED'
            : this.fallbackCode(statusCode),
      message: isFieldErrors
        ? 'Request validation failed.'
        : typeof rawMessage === 'string'
          ? rawMessage
          : exception.message,
      details: isFieldErrors ? rawMessage : record.details,
    };
  }

  private fallbackCode(statusCode: number): string {
    const known: Record<number, string> = {
      400: 'BAD_REQUEST',
      404: 'NOT_FOUND',
      405: 'METHOD_NOT_ALLOWED',
      409: 'CONFLICT',
      412: 'PRECONDITION_FAILED',
      415: 'UNSUPPORTED_MEDIA_TYPE',
    };
    return known[statusCode] ?? `HTTP_${statusCode}`;
  }
}
