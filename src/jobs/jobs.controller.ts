import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { CreateJobDto } from './dto/create-job.dto.js';
import {
  PaginationQueryDto,
  SearchJobsQueryDto,
} from './dto/search-jobs.dto.js';
import { UpdateJobDto } from './dto/update-job.dto.js';
import type { Job } from './job.entity.js';
import { JobsService, type Page } from './jobs.service.js';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateJobDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('idempotency-key') idempotencyKey?: string,
  ): Promise<Job> {
    const { job, replayed } = await this.jobs.create(dto, idempotencyKey);
    // 재요청으로 기존 결과를 돌려준 것인지 클라이언트가 구분할 수 있게 한다.
    res.setHeader('Idempotent-Replay', String(replayed));
    res.setHeader('Location', `/jobs/${job.id}`);
    res.setHeader('ETag', `"${job.version}"`);
    return job;
  }

  @Get()
  async findAll(@Query() query: PaginationQueryDto): Promise<Page<Job>> {
    return this.jobs.findAll(query);
  }

  /**
   * 검색.
   *
   * 이 라우트는 반드시 '/jobs/:id' 보다 먼저 선언되어야 한다.
   * 순서가 바뀌면 'search' 가 id 값으로 잡혀 검색이 동작하지 않는다.
   * 순서에만 기대지 않도록 :id 쪽에 ParseUUIDPipe 도 함께 걸어 두었다.
   */
  @Get('search')
  async search(@Query() query: SearchJobsQueryDto): Promise<Page<Job>> {
    return this.jobs.search(query);
  }

  @Get(':id')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Job> {
    const job = await this.jobs.findOne(id);
    // 클라이언트는 이 값을 PATCH 의 If-Match 로 돌려보내 덮어쓰기를 막을 수 있다.
    res.setHeader('ETag', `"${job.version}"`);
    return job;
  }

  @Patch(':id')
  async update(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateJobDto,
    @Res({ passthrough: true }) res: Response,
    @Headers('if-match') ifMatch?: string,
  ): Promise<Job> {
    const job = await this.jobs.update(id, dto, ifMatch);
    res.setHeader('ETag', `"${job.version}"`);
    return job;
  }
}
