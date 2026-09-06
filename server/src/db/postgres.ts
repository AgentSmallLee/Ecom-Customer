// server/src/db/postgres.ts
import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

export const pool = new pg.Pool({
  host:     process.env.PG_HOST     || 'localhost',
  port:     parseInt(process.env.PG_PORT || '5432'),
  user:     process.env.PG_USER     || 'postgres',
  password: process.env.PG_PASSWORD || 'postgres',
  database: process.env.PG_DATABASE || 'langchain_course',
});
