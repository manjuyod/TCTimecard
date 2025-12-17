import 'express-session';
import type { AuthSessionData } from '../auth/types';

declare module 'express-session' {
  interface SessionData {
    auth?: AuthSessionData;
  }
}
