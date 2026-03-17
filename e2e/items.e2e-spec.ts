/** @author Shuja naqvi */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { GlobalExceptionFilter } from '../src/common/global-exception.filter';
import { Reflector } from '@nestjs/core';
import JwtAuthGuard from '../src/auth/guards/jwt-auth-guard';

describe('Items (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    app.useGlobalFilters(new GlobalExceptionFilter());
    const reflector = app.get(Reflector);
    app.useGlobalGuards(new JwtAuthGuard(reflector));
    await app.init();
  });

  it('/api/v1/items (GET) - list items', () => {
    return request(app.getHttpServer())
      .get('/api/v1/items')
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('items');
        expect(Array.isArray(res.body.items)).toBe(true);
      });
  });

  afterAll(async () => {
    await app.close();
  });
});
