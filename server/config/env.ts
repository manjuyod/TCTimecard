import type { PoolConfig } from 'pg';
import type { config as MssqlConnectionConfig } from 'mssql';
import dotenv from 'dotenv';

dotenv.config();

const truthy = new Set(['1', 'true', 'yes', 'y', 'on']);
const falsy = new Set(['0', 'false', 'no', 'n', 'off']);

const parseBoolean = (name: string, value: unknown, defaultValue = false): boolean => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  const normalized = String(value).toLowerCase();
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;

  throw new Error(`[env] ${name} must be a boolean-like value (true/false). Received: ${value}`);
};

const parseInteger = (
  name: string,
  value: unknown,
  defaultValue?: number,
  { min }: { min?: number } = {}
): number => {
  if (value === undefined || value === null || value === '') {
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(`[env] ${name} is required`);
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`[env] ${name} must be an integer. Received: ${value}`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`[env] ${name} must be >= ${min}. Received: ${parsed}`);
  }

  return parsed;
};

const requireString = (name: string, value: unknown): string => {
  if (value === undefined || value === null) {
    throw new Error(`[env] ${name} is required`);
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    throw new Error(`[env] ${name} is required and cannot be empty`);
  }
  return trimmed;
};

export type PostgresConfig = PoolConfig & { connectionString: string };
export type MssqlConfig = MssqlConnectionConfig;

export const getPostgresConfig = (): PostgresConfig => {
  const connectionString = requireString(
    'POSTGRES_URL or DATABASE_URL',
    process.env.POSTGRES_URL || process.env.DATABASE_URL
  );
  if (!/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error('[env] POSTGRES_URL/DATABASE_URL must start with postgres:// or postgresql://');
  }

  const max = parseInteger('POSTGRES_POOL_MAX', process.env.POSTGRES_POOL_MAX, 10, { min: 1 });
  const idleTimeoutMillis = parseInteger('POSTGRES_POOL_IDLE', process.env.POSTGRES_POOL_IDLE, 30000, { min: 1000 });
  const connectionTimeoutMillis = parseInteger(
    'POSTGRES_CONNECTION_TIMEOUT',
    process.env.POSTGRES_CONNECTION_TIMEOUT,
    10000,
    { min: 1000 }
  );
  const sslEnabled = parseBoolean('POSTGRES_SSL', process.env.POSTGRES_SSL, true);
  const rejectUnauthorized = parseBoolean(
    'POSTGRES_SSL_REJECT_UNAUTHORIZED',
    process.env.POSTGRES_SSL_REJECT_UNAUTHORIZED,
    false
  );

  return {
    connectionString,
    ssl: sslEnabled ? { rejectUnauthorized } : false,
    max,
    idleTimeoutMillis,
    connectionTimeoutMillis
  };
};

export const getMssqlConfig = (): MssqlConfig => {
  const server = requireString('MSSQL_SERVER', process.env.MSSQL_SERVER);
  const database = requireString('MSSQL_DATABASE', process.env.MSSQL_DATABASE);
  const user = requireString('MSSQL_USER', process.env.MSSQL_USER);
  const password = requireString('MSSQL_PASSWORD', process.env.MSSQL_PASSWORD);
  const port = parseInteger('MSSQL_PORT', process.env.MSSQL_PORT, 1433, { min: 1 });
  const encrypt = parseBoolean('MSSQL_ENCRYPT', process.env.MSSQL_ENCRYPT, true);
  const trustServerCertificate = parseBoolean(
    'MSSQL_TRUST_SERVER_CERTIFICATE',
    process.env.MSSQL_TRUST_SERVER_CERTIFICATE,
    false
  );
  const poolMax = parseInteger('MSSQL_POOL_MAX', process.env.MSSQL_POOL_MAX, 10, { min: 1 });
  const poolMin = parseInteger('MSSQL_POOL_MIN', process.env.MSSQL_POOL_MIN, 0, { min: 0 });
  const idleTimeoutMillis = parseInteger('MSSQL_POOL_IDLE', process.env.MSSQL_POOL_IDLE, 30000, { min: 1000 });
  const connectionTimeout = parseInteger('MSSQL_CONNECTION_TIMEOUT', process.env.MSSQL_CONNECTION_TIMEOUT, 15000, {
    min: 1000
  });
  const requestTimeout = parseInteger('MSSQL_REQUEST_TIMEOUT', process.env.MSSQL_REQUEST_TIMEOUT, 30000, {
    min: 1000
  });

  return {
    user,
    password,
    server,
    database,
    port,
    options: {
      encrypt,
      trustServerCertificate
    },
    pool: {
      max: poolMax,
      min: poolMin,
      idleTimeoutMillis
    },
    connectionTimeout,
    requestTimeout
  };
};

export const validateDbEnv = () => ({
  postgres: getPostgresConfig(),
  mssql: getMssqlConfig()
});
