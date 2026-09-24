import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';
import { RequestLoggerMiddleware } from './common/request-logger.middleware.js';

/**
 * 파이프와 예외 필터 설정.
 * main.ts 와 e2e 테스트가 같은 설정을 쓰도록 한곳에 모았다.
 * 테스트와 실제 실행의 동작이 갈리면 테스트가 의미를 잃는다.
 */
export const configureApp = (app: INestApplication): void => {
  // app.use() 는 즉시 붙고, Nest 는 init() 에서 그 뒤에 body-parser 를 붙인다.
  // 그래서 파서가 거부하는 요청(413, 깨진 JSON)도 requestId 를 받고 로그에 남는다.
  const requestLogger = app.get(RequestLoggerMiddleware);
  app.use(requestLogger.use.bind(requestLogger));

  app.useGlobalPipes(
    new ValidationPipe({
      // DTO 에 없는 필드는 제거하고
      whitelist: true,
      // 넘어왔다는 사실 자체를 400 으로 알린다.
      // 오타 난 필드가 조용히 무시되는 것이 제일 나쁘다.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
};
