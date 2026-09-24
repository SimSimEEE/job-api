import { IsOptional, IsString, Length } from 'class-validator';

export class CreateJobDto {
  @IsString()
  @Length(1, 200)
  title!: string;

  /** 설명은 없어도 되며, 없으면 빈 문자열로 저장한다. */
  @IsOptional()
  @IsString()
  @Length(0, 2000)
  description?: string;
}
