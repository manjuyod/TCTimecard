import sql, { ConnectionPool } from 'mssql';
import { getMssqlConfig } from '../config/env';

let poolPromise: Promise<ConnectionPool> | undefined;

const getMssqlPool = (): Promise<ConnectionPool> => {
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

export { sql, getMssqlPool };
