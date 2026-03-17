/** @author Shuja naqvi */
import { createLogger, format, transports } from 'winston';

const env = process.env.NODE_ENV || 'development';
const isDevelopment = env === 'development';

const localFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  format.json(),
  format.prettyPrint(),
);

const remoteFormat = format.combine(
  format.timestamp({ format: 'YYYY-MM-DDTHH:mm:ss.SSSZ' }),
  format.json(),
);

const logTransports = [new transports.Console()];

export const loggerOptions = {
  level: isDevelopment ? 'debug' : 'http',
  format: isDevelopment ? localFormat : remoteFormat,
  transports: logTransports,
};

export default createLogger(loggerOptions);
