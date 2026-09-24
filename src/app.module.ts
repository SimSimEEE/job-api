import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { CoreModule } from './core.module.js';
import { JobsModule } from './jobs/jobs.module.js';

// 요청 로깅 미들웨어는 여기(consumer.apply)가 아니라 setup.ts 의 app.use() 로 붙인다.
// 모듈 미들웨어는 Nest 가 body-parser 를 등록한 뒤에 붙어서, 파서가 거부한 요청
// (413 본문 초과, 깨진 JSON)은 로그에도 requestId 에도 잡히지 않기 때문이다.
@Module({
  imports: [ScheduleModule.forRoot(), CoreModule, JobsModule],
})
export class AppModule {}
