import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * 도메인 오류. 전역 예외 필터가 이 모양을 그대로 응답 본문으로 쓴다.
 * code 는 사람이 읽는 message 와 별개로 클라이언트가 분기할 수 있는 안정적인 식별자다.
 */
export class DomainException extends HttpException {
  constructor(
    readonly code: string,
    message: string,
    status: HttpStatus,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, status);
  }
}

export class JobNotFoundException extends DomainException {
  constructor(id: string) {
    super('JOB_NOT_FOUND', `Job '${id}' does not exist.`, HttpStatus.NOT_FOUND);
  }
}

/** 상태 전이 규칙 위반. 자원의 현재 상태와 요청이 충돌하므로 409. */
export class InvalidTransitionException extends DomainException {
  constructor(from: string, to: string, allowed: readonly string[]) {
    super(
      'INVALID_STATUS_TRANSITION',
      `Cannot change status from '${from}' to '${to}'.`,
      HttpStatus.CONFLICT,
      {
        from,
        to,
        allowed,
      },
    );
  }
}

/** 바꿀 필드가 하나도 없는 PATCH. 아무것도 안 바꾸면서 버전만 올리는 것을 막는다. */
export class EmptyUpdateException extends DomainException {
  constructor() {
    super(
      'EMPTY_UPDATE',
      'PATCH would change nothing. Send title, description or status with a value different from the current one.',
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** 실행 중이거나 끝난 작업의 입력(title, description)은 바꿀 수 없다. */
export class ContentNotEditableException extends DomainException {
  constructor(status: string) {
    super(
      'CONTENT_NOT_EDITABLE',
      `Title and description cannot be edited while the job is '${status}'.`,
      HttpStatus.CONFLICT,
      { status, editableIn: ['pending', 'failed'] },
    );
  }
}

/** If-Match 값이 엔티티 태그(버전 숫자)도 "*" 도 아님. 안 맞는 버전(412)이 아니라 잘못된 요청. */
export class InvalidIfMatchException extends DomainException {
  constructor(value: string) {
    super(
      'IF_MATCH_INVALID',
      `If-Match must be a version tag like "3", or *. Got: ${value}`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/** Idempotency-Key 헤더 형식 오류. */
export class InvalidIdempotencyKeyException extends DomainException {
  constructor(reason: string) {
    super(
      'IDEMPOTENCY_KEY_INVALID',
      `Idempotency-Key ${reason}.`,
      HttpStatus.BAD_REQUEST,
    );
  }
}

/**
 * If-Match 로 받은 버전이 현재 버전과 다름.
 * RFC 9110 상 If-Match 실패는 409 가 아니라 412 다.
 */
export class VersionConflictException extends DomainException {
  constructor(expected: string, actual: number) {
    super(
      'VERSION_CONFLICT',
      'The job was modified by someone else. Re-read it and retry.',
      HttpStatus.PRECONDITION_FAILED,
      { expected, actual },
    );
  }
}

/** 같은 Idempotency-Key 로 다른 본문이 들어옴. */
export class IdempotencyKeyReuseException extends DomainException {
  constructor(key: string) {
    super(
      'IDEMPOTENCY_KEY_REUSED',
      `Idempotency-Key '${key}' was already used with a different request body.`,
      HttpStatus.CONFLICT,
      { key },
    );
  }
}
