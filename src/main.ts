import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { loadEnv } from './config.js';

const env = loadEnv();
const app = await NestFactory.create<NestExpressApplication>(AppModule);
// Trust X-Forwarded-For only from this machine (the web and admin servers), so audit IPs are the real client.
app.set('trust proxy', 'loopback');
app.enableShutdownHooks();
// OpenAPI spec for sport_link_fe's generated client: UI at /docs, JSON at /docs-json. Not served in production.
if (env.NODE_ENV !== 'production') {
  const doc = new DocumentBuilder().setTitle('SportsLink API').setVersion('0.1.0').addBearerAuth().build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
}
await app.listen(env.PORT);
console.log(`SportsLink API listening on port ${env.PORT}`);
