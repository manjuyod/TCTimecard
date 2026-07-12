export interface InFlightCoalescer<T> {
  readonly size: number;
  run(key: string, work: () => Promise<T>): Promise<T>;
}

export const createInFlightCoalescer = <T>(): InFlightCoalescer<T> => {
  const inFlight = new Map<string, Promise<T>>();

  return {
    get size() {
      return inFlight.size;
    },
    run(key, work) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      let started: Promise<T>;
      try {
        started = work();
      } catch (error) {
        started = Promise.reject(error);
      }

      let active!: Promise<T>;
      active = started.finally(() => {
          if (inFlight.get(key) === active) inFlight.delete(key);
        });
      inFlight.set(key, active);
      return active;
    }
  };
};
