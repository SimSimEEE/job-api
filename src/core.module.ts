import { Module } from '@nestjs/common';
import { FileLoggerService } from './common/file-logger.service.js';
import { RequestLoggerMiddleware } from './common/request-logger.middleware.js';
import { APP_CONFIG, loadConfig } from './config/app.config.js';

/**
 * 설정과 파일 로거처럼 여러 모듈이 함께 쓰는 것들.
 * @Global 대신 필요한 모듈이 명시적으로 import 하게 두었다.
 * 어떤 모듈이 무엇에 의존하는지 코드에 드러나는 편이 낫다.
 */
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    FileLoggerService,
    RequestLoggerMiddleware,
  ],
  exports: [APP_CONFIG, FileLoggerService, RequestLoggerMiddleware],
})
export class CoreModule {}
