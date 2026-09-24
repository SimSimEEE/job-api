import { Module } from '@nestjs/common';
import { CoreModule } from '../core.module.js';
import { JobsController } from './jobs.controller.js';
import { JobsRepository } from './jobs.repository.js';
import { JobsScheduler } from './jobs.scheduler.js';
import { JobsService } from './jobs.service.js';

@Module({
  imports: [CoreModule],
  controllers: [JobsController],
  providers: [JobsRepository, JobsService, JobsScheduler],
  exports: [JobsRepository, JobsService, JobsScheduler],
})
export class JobsModule {}
