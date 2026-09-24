import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { JOB_STATUSES, type JobStatus } from '../job.entity.js';

export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** 상한을 두지 않으면 한 번의 요청으로 전체를 끌어갈 수 있어 100 으로 막았다. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;
}

export class SearchJobsQueryDto extends PaginationQueryDto {
  /** 제목 부분 일치, 대소문자 구분 없음. */
  @IsOptional()
  @IsString()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  title?: string;

  /**
   * 상태 필터. 여러 개를 함께 줄 수 있다.
   *   ?status=pending           → 하나
   *   ?status=pending,failed    → 쉼표로 여러 개
   *   ?status=pending&status=failed → 반복 파라미터
   */
  @IsOptional()
  @Transform(({ value }) => {
    const raw = Array.isArray(value) ? value : [value];
    return raw
      .flatMap((v) => (typeof v === 'string' ? v.split(',') : v))
      .map((v) => (typeof v === 'string' ? v.trim() : v))
      .filter((v) => v !== '');
  })
  @IsArray()
  @IsIn(JOB_STATUSES, { each: true })
  status?: JobStatus[];
}
