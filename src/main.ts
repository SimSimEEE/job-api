import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { APP_CONFIG, type AppConfig } from './config/app.config.js';
import { configureApp } from './setup.js';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // 종료 시 로그 스트림을 닫기 위해 필요하다.
  app.enableShutdownHooks();

  // PORT 도 다른 설정과 같은 검증을 거친다. 틀리면 여기까지 오기 전에 기동이 멈춘다.
  const { port } = app.get<AppConfig>(APP_CONFIG);
  await app.listen(port);
  new Logger('Bootstrap').log(`http://localhost:${port} 에서 대기 중입니다.`);
};

await bootstrap();
