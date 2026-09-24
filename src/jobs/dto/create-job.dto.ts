import { Transform } from 'class-transformer';
import { IsString, Length, ValidateIf } from 'class-validator';

export class CreateJobDto {
  /** 앞뒤 공백을 걷어낸 뒤 길이를 본다. 공백만인 제목은 제목이 아니다. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 200)
  title!: string;

  /** 설명은 생략할 수 있고 없으면 빈 문자열로 저장한다. null 은 생략이 아니라 잘못된 값이다. */
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @Length(0, 2000)
  description?: string;
}
