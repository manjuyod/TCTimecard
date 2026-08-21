import type { Pool, PoolClient } from 'pg';

export type PtoQueryable = Pick<Pool | PoolClient, 'query'>;
