import { useContext, useEffect, useRef } from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';

export type PendingEntryNavigation = { proceed: () => void; reset: () => void };
type Props = { onAttempt: (navigation: PendingEntryNavigation) => void };

// Standalone dialog tests/embeds may not have a router. The app always uses a data router.
export function TimeEntryNavigationGuard(props: Props): JSX.Element | null {
  const router = useContext(UNSAFE_DataRouterContext);
  return router ? <DataRouterEntryGuard {...props} /> : null;
}

function DataRouterEntryGuard({ onAttempt }: Props): null {
  const blocker = useBlocker(true);
  const attempt = useRef(onAttempt);
  attempt.current = onAttempt;
  useEffect(() => {
    if (blocker.state === 'blocked') attempt.current({ proceed: blocker.proceed, reset: blocker.reset });
  }, [blocker]);
  return null;
}
