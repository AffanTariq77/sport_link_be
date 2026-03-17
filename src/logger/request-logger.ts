/** @author Shuja naqvi */
import { Request } from 'express';
import morgan, { StreamOptions } from 'morgan';
import baseLogger from './logger';

const logger = baseLogger.child({ type: 'request' });

export const requestLogger = (): ReturnType<typeof morgan> => {
  const stream: StreamOptions = {
    write: (message: string) => {
      try {
        logger.http(JSON.parse(message));
      } catch {
        logger.http(message);
      }
    },
  };

  morgan.token('endpoint', (req: Request) => {
    if (!req.route) {
      return 'NoEndpointFound';
    }
    return `${req.method} ${req.route.path}`;
  });

  return morgan(
    (tokens, req: Request, res) =>
      JSON.stringify({
        endpoint: tokens.endpoint(req, res),
        ip: req.ip,
        requestId: tokens.res(req, res, 'x-request-id'),
        responseSizeBytes: Number(tokens.res(req, res, 'content-length')),
        responseStatus: Number(tokens.status(req, res)),
        responseTimeMs: Number(tokens['response-time'](req, res)),
        url: tokens.url(req, res),
      }),
    { stream },
  );
};
