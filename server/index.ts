import fs from 'fs';
import path from 'path';
import compression from 'compression';
import cors from 'cors';
import dotenv from 'dotenv';
import express, { NextFunction, Request, Response } from 'express';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import authRoutes from './routes/auth';
import payPeriodRoutes from './routes/payPeriod';
import hoursRoutes from './routes/hours';
import extraHoursRoutes from './routes/extrahours';
import timeOffRoutes from './routes/timeoff';
import { validateDbEnv } from './config/env';
import { SESSION_COOKIE_NAME, SESSION_SECRET, SESSION_SAME_SITE, SESSION_SECURE, SESSION_TTL_MS } from './config/session';

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

try {
  validateDbEnv();
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[startup] Database environment validation failed:', message);
  process.exit(1);
}

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[session] SESSION_SECRET not set; using development fallback. Set SESSION_SECRET in your environment for production.'
  );
}

app.set('trust proxy', 1);

app.use(helmet());
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    credentials: true
  })
);
app.use(compression());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

app.use(
  session({
    name: SESSION_COOKIE_NAME,
    secret: SESSION_SECRET,
    resave: false,
    rolling: true,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: SESSION_SECURE,
      sameSite: SESSION_SAME_SITE,
      maxAge: SESSION_TTL_MS
    }
  })
);

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use('/api/auth', authRoutes);
app.use('/api/pay-period', payPeriodRoutes);
app.use('/api', hoursRoutes);
app.use('/api', extraHoursRoutes);
app.use('/api', timeOffRoutes);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

const serverRoot = path.basename(__dirname) === 'dist' ? path.resolve(__dirname, '..') : __dirname;
const distPath = path.resolve(serverRoot, '..', 'client', 'dist');
const indexFile = path.join(distPath, 'index.html');

if (fs.existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (_req, res) => res.sendFile(indexFile));
} else {
  app.get('/', (_req, res) => {
    res
      .status(200)
      .json({ message: 'Client build not found. Run `npm run dev` for Vite or `npm run build` before start.' });
  });
  app.get('*', (_req, res) => res.status(404).json({ error: 'Not found' }));
}

// Centralized error handler to ensure API routes always return JSON instead of Express HTML error pages
app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const status =
    typeof (err as { status?: number } | null | undefined)?.status === 'number'
      ? (err as { status: number }).status
      : 500;
  const safeStatus = status >= 400 && status < 600 ? status : 500;
  const message = err instanceof Error ? err.message : 'Internal server error';

  console.error('[error]', req.method, req.originalUrl, err);

  if (res.headersSent) {
    return;
  }

  if (req.originalUrl.startsWith('/api')) {
    res.status(safeStatus).json({ error: message });
  } else {
    res.status(safeStatus).send(message);
  }
});

app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});
