import { Transform } from 'class-transformer';
import { IsIn, IsString, Length, ValidateIf } from 'class-validator';
import { JOB_STATUSES, type JobStatus } from '../job.entity.js';

/**
 * PATCH 로 바꿀 수 있는 필드는 title, description, status 뿐이다.
 * id, version, attempts, 각종 시각은 서버가 정하며 요청으로 덮을 수 없다.
 * (ValidationPipe 의 forbidNonWhitelisted 로 그 외 필드는 400 이 된다.)
 *
 * @IsOptional 을 쓰지 않는다. 그 데코레이터는 null 도 "없음"으로 보고 검증을 건너뛰어
 * title: null 이 그대로 저장된다. 생략(undefined)만 허용하고 null 은 잘못된 값으로 본다.
 */
export class UpdateJobDto {
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  title?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(0, 2000)
  description?: string;

  @ValidateIf((_, value) => value !== undefined)
  @IsIn(JOB_STATUSES)
  status?: JobStatus;
}
