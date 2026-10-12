/**
 * Calls `send` at most once per `intervalMs`, always delivering a final call after a burst.
 * Used to turn many small progress events into a few "something changed" pings (about 10 a second).
 */
export function createThrottle(send: () => void, intervalMs = 100): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  let last = 0;
  const fire = () => {
    timer = null;
    if (!pending) return;
    pending = false;
    last = Date.now();
    send();
  };
  return () => {
    pending = true;
    if (timer) return;
    const wait = Math.max(0, last + intervalMs - Date.now());
    timer = setTimeout(fire, wait);
  };
}
