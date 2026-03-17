/** @author Shuja naqvi */
import { merge } from 'lodash';

const DEFAULT_CONFIG = {
  JWT: {
    secret: 'boilerplate-jwt-secret-change-in-production',
    expiration: '7d',
  },
  CORS: {
    origins: '*',
  },
};

const ENV_CONFIG = {
  CORS: {
    origins: process.env.CORS_ORIGINS ?? '*',
  },
  JWT: {
    secret: process.env.JWT_SECRET,
    expiration: process.env.JWT_EXPIRATION ?? '7d',
  },
};

export const CONFIG = merge(DEFAULT_CONFIG, ENV_CONFIG);
