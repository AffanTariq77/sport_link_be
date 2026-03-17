/** @author Shuja naqvi */
import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService, TypeOrmHealthIndicator } from '@nestjs/terminus';
import { Public } from '../../auth/decorators/public.decorator';

@Controller('health')
export class HealthController {
  constructor(
    private readonly db: TypeOrmHealthIndicator,
    private readonly health: HealthCheckService,
  ) {}

  @Public()
  @Get()
  @HealthCheck()
  public async check() {
    return this.health.check([async () => this.db.pingCheck('database')]);
  }
}
