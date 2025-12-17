interface AttemptState {
  attempts: number;
  firstAttemptAt: number;
  cooldownUntil?: number;
}

const prune = (map: Map<string, AttemptState>, now: number) => {
  for (const [key, state] of map) {
    if (state.cooldownUntil && state.cooldownUntil <= now) {
      map.delete(key);
    }
  }
};

export class LoginRateLimiter {
  private readonly maxAttempts: number;
  private readonly cooldownMs: number;
  private identifierAttempts = new Map<string, AttemptState>();
  private ipAttempts = new Map<string, AttemptState>();

  constructor(maxAttempts = 5, cooldownMinutes = 10) {
    this.maxAttempts = maxAttempts;
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  private normalizeIdentifier(identifier: string): string {
    return identifier.trim().toLowerCase();
  }

  private isBlocked(map: Map<string, AttemptState>, key: string, now: number): boolean {
    const state = map.get(key);
    if (!state) return false;
    if (state.cooldownUntil && state.cooldownUntil > now) {
      return true;
    }
    if (state.cooldownUntil && state.cooldownUntil <= now) {
      map.delete(key);
      return false;
    }
    return false;
  }

  private noteFailure(map: Map<string, AttemptState>, key: string, now: number): AttemptState {
    const current = map.get(key);
    if (current && current.cooldownUntil && current.cooldownUntil > now) {
      return current;
    }

    const next: AttemptState = current && (!current.cooldownUntil || current.cooldownUntil <= now)
      ? { ...current, attempts: current.attempts + 1, cooldownUntil: current.cooldownUntil ?? undefined }
      : { attempts: 1, firstAttemptAt: now };

    if (next.attempts >= this.maxAttempts) {
      next.cooldownUntil = now + this.cooldownMs;
    }

    map.set(key, next);
    return next;
  }

  public isIpBlocked(ip: string): boolean {
    const now = Date.now();
    prune(this.ipAttempts, now);
    return this.isBlocked(this.ipAttempts, ip, now);
  }

  public isIdentifierBlocked(identifier: string): boolean {
    const now = Date.now();
    prune(this.identifierAttempts, now);
    return this.isBlocked(this.identifierAttempts, this.normalizeIdentifier(identifier), now);
  }

  public recordFailure(identifier: string, ip: string): void {
    const now = Date.now();
    prune(this.identifierAttempts, now);
    prune(this.ipAttempts, now);

    this.noteFailure(this.ipAttempts, ip, now);
    this.noteFailure(this.identifierAttempts, this.normalizeIdentifier(identifier), now);
  }

  public reset(identifier: string, ip: string): void {
    this.identifierAttempts.delete(this.normalizeIdentifier(identifier));
    this.ipAttempts.delete(ip);
  }
}
