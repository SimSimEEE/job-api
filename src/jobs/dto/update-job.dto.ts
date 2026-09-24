import { IsIn, IsOptional, IsString, Length } from 'class-validator';
import { JOB_STATUSES, type JobStatus } from '../job.entity.js';

/**
 * PATCH 로 바꿀 수 있는 필드는 title, description, status 뿐이다.
 * id, version, attempts, 각종 시각은 서버가 정하며 요청으로 덮을 수 없다.
 * (ValidationPipe 의 forbidNonWhitelisted 로 그 외 필드는 400 이 된다.)
 */
export class UpdateJobDto {
  @IsOptional()
  @IsString()
  @Length(1, 200)
  title?: string;

  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;

  @IsOptional()
  @IsIn(JOB_STATUSES)
  status?: JobStatus;
}
