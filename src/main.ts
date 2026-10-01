import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import { loadEnv } from './config.js';
import { rateLimit, securityHeaders } from './security/http.js';

// A bootstrap() function rather than top-level await: Vercel loads this module and captures the server from listen().
async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Trust X-Forwarded-For only from this machine (the web and admin servers), so audit IPs are the real client.
  // On Vercel every request arrives through Vercel's proxy, which sets X-Forwarded-For to the caller's address.
  // ponytail: calls from the web app on Vercel share its outbound address for rate limiting; forward a signed client IP if that bites.
  app.set('trust proxy', process.env.VERCEL ? true : 'loopback');
  app.disable('x-powered-by');
  app.use(securityHeaders(env.NODE_ENV === 'production'));
  app.use(rateLimit({ windowMs: 60_000, general: 300, auth: 20 }));
  app.enableShutdownHooks();
  // OpenAPI spec for sport_link_fe's generated client: UI at /docs, JSON at /docs-json. Not served in production.
  if (env.NODE_ENV !== 'production') {
    const doc = new DocumentBuilder().setTitle('SportsLink API').setVersion('0.1.0').addBearerAuth().build();
    SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc));
  }
  await app.listen(env.PORT);
  console.log(`SportsLink API listening on port ${env.PORT}`);
}

void bootstrap();
