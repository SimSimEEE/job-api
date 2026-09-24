import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './setup.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // 종료 시 로그 스트림을 닫기 위해 필요하다.
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  new Logger('Bootstrap').log(`http://localhost:${port} 에서 대기 중입니다.`);
};

await bootstrap();
