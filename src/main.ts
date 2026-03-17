/** @author Shuja naqvi */
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { json, urlencoded } from 'body-parser';
import { v4 as uuidv4 } from 'uuid';
import { AppModule } from './app.module';
import JwtAuthGuard from './auth/guards/jwt-auth-guard';
import { GlobalExceptionFilter } from './common/global-exception.filter';
import { CONFIG } from './config';
import { requestLogger } from './logger/request-logger';
import { join } from 'path';

const bootstrap = async (): Promise<void> => {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: { origin: CONFIG.CORS.origins },
  });

  app.enable('trust proxy');

  app.use((req, res, next) => {
    const guid = uuidv4();
    req.headers['x-request-id'] = guid;
    res.setHeader('X-Request-ID', guid);
    next();
  });

  app.use(json({ limit: '5mb' }));
  app.use(urlencoded({ limit: '5mb', extended: true }));

  app.setGlobalPrefix('api');
  const reflector = app.get(Reflector);
  app.useGlobalGuards(new JwtAuthGuard(reflector));
  app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
  app.useGlobalFilters(new GlobalExceptionFilter());

  app.use(requestLogger());

  app.enableVersioning({ type: VersioningType.URI });
  app.useStaticAssets(join(__dirname, 'public'));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
};

void bootstrap();
