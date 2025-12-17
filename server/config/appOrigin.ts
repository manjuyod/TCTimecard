const APP_ORIGIN = (process.env.APP_ORIGIN || process.env.CLIENT_ORIGIN || 'http://localhost:5173').replace(/\/+$/, '');

export { APP_ORIGIN };

