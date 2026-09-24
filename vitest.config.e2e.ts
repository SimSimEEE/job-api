import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    // e2e 스펙은 각자 임시 데이터 파일과 로그 파일을 쓰지만,
    // node-json-db 의 잠금이 프로세스 전역이라 파일별로 프로세스를 분리한다.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
