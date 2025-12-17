export const SESSION_COOKIE_NAME = 'timecard.sid';
export const SESSION_TTL_MS = 15 * 60 * 1000;
export const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-session-secret';
export const SESSION_SAME_SITE: 'lax' = 'lax';
export const SESSION_SECURE = process.env.NODE_ENV === 'production';
