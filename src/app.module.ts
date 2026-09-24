import {
  Module,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { RequestLoggerMiddleware } from './common/request-logger.middleware.js';
import { CoreModule } from './core.module.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [ScheduleModule.forRoot(), CoreModule, JobsModule],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // 매칭되지 않은 경로(404)까지 포함해 모든 요청을 기록한다.
    consumer.apply(RequestLoggerMiddleware).forRoutes('*splat');
  }
}
