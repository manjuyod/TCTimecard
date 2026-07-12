import sql, { ConnectionPool } from 'mssql';
import { getMssqlConfig } from '../config/env';

let poolPromise: Promise<ConnectionPool> | undefined;
let poolOverride: Promise<ConnectionPool> | ConnectionPool | undefined;

const getMssqlPool = (): Promise<ConnectionPool> => {
  if (poolOverride) {
    return Promise.resolve(poolOverride);
  }

  if (!poolPromise) {
    const config = getMssqlConfig();
    poolPromise = new sql.ConnectionPool(config)
      .connect()
      .then((pool: ConnectionPool) => {
        pool.on('error', (err: Error) => {
          console.error('[mssql] Unexpected pool error', err);
        });
        return pool;
      })
      .catch((err: Error) => {
        poolPromise = undefined;
        throw err;
      });
  }

  return poolPromise;
};

const setMssqlPoolOverride = (nextPool?: Promise<ConnectionPool> | ConnectionPool): void => {
  poolOverride = nextPool;
};

const closeMssqlPool = async (): Promise<void> => {
  const current = poolOverride ?? poolPromise;
  poolOverride = undefined;
  poolPromise = undefined;
  if (!current) return;
  const connected = await Promise.resolve(current);
  await connected.close();
};

export { sql, getMssqlPool, setMssqlPoolOverride, closeMssqlPool };
