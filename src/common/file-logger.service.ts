import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { APP_CONFIG, type AppConfig } from '../config/app.config.js';

export type LogChannel = 'http' | 'scheduler';

export interface LogEntry {
  channel: LogChannel;
  [key: string]: unknown;
}

/**
 * logs.txt 에 한 줄 = 한 JSON(JSON Lines)으로 기록한다.
 * 줄 단위 JSON 이라 나중에 jq 나 스크립트로 그대로 집계할 수 있다.
 *
 * 여기에는 뮤텍스를 쓰지 않았다.
 * append 모드 WriteStream 은 내부적으로 쓰기를 큐에 넣어 순서대로 흘리므로
 * 줄이 섞이지 않는다. 필요 없는 곳까지 잠금을 두면 잠금의 의미가 흐려진다.
 */
@Injectable()
export class FileLoggerService implements OnApplicationShutdown {
  private readonly stream: WriteStream;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    mkdirSync(dirname(config.logPath), { recursive: true });
    this.stream = createWriteStream(config.logPath, { flags: 'a' });
    // 스트림 오류를 처리하지 않으면 프로세스가 죽는다.
    // 로그를 못 쓰는 것이 서비스를 멈출 이유는 아니다.
    this.stream.on('error', (err) => {
      console.error(`[FileLogger] write failed: ${err.message}`);
    });
  }

  /**
   * 절대 던지지 않는다.
   * 로깅 호출이 기록하려던 요청을 죽이는 일은 없어야 한다.
   * 직렬화가 실패하면(순환 참조, BigInt 등) 그 사실을 대신 기록한다.
   */
  log(entry: LogEntry): void {
    let line: string;
    try {
      line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    } catch (err) {
      line = JSON.stringify({
        timestamp: new Date().toISOString(),
        channel: entry.channel,
        event: 'log.serialize_failed',
        originalEvent:
          typeof entry.event === 'string' ? entry.event : undefined,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    this.stream.write(`${line}\n`);
  }

  /** 테스트에서 파일을 읽기 전에 버퍼를 비우기 위해 쓴다. */
  async flush(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      // 빈 쓰기의 콜백은 앞선 쓰기가 모두 처리된 뒤에 불린다.
      this.stream.write('', (err) => (err ? reject(err) : resolve()));
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await new Promise<void>((resolve) => this.stream.end(resolve));
  }
}
