import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './common/all-exceptions.filter.js';

/**
 * 파이프와 예외 필터 설정.
 * main.ts 와 e2e 테스트가 같은 설정을 쓰도록 한곳에 모았다.
 * 테스트와 실제 실행의 동작이 갈리면 테스트가 의미를 잃는다.
 */
export const configureApp = (app: INestApplication): void => {
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
