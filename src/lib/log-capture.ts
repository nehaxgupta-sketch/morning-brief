// src/lib/log-capture.ts
//
// Sprint 14.5 — server-side log capture (Layer 2). The admin run log used to
// miss everything the API routes log (per-story strip/dead-link/backfill lines,
// per-desk writer/scorer lines, coherence flags) because those run server-side
// and only reached Vercel logs. This lets each /api route tee its own
// console output into an array and return it as `logs`, which the admin page
// then folds into the downloadable run log.
//
// Usage in a handler:
//   const cap = createLogCapture();
//   try { ...; return res.status(200).json({ ...out, logs: cap.logs }); }
//   catch (e) { return res.status(500).json({ ok:false, error, logs: cap.logs }); }
//   finally { cap.restore(); }
//
// Note: this monkeypatches the global console for the duration of the request
// and restores it in `finally`. The admin pipeline calls routes sequentially
// for a single operator, so interleaving isn't a concern here; the restore
// guarantees it never leaks across invocations on a warm serverless instance.

function istClock(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(11, 19);
}

function fmtArg(a: any): string {
  if (typeof a === 'string') return a;
  try { return JSON.stringify(a); } catch { return String(a); }
}

export function createLogCapture(maxLines = 1500): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  const push = (level: string, args: any[]) => {
    logs.push(`${istClock()} ${level} ${args.map(fmtArg).join(' ')}`);
    if (logs.length > maxLines) logs.shift();
  };
  console.log = (...a: any[]) => { push('log', a); orig.log(...a); };
  console.info = (...a: any[]) => { push('info', a); orig.info(...a); };
  console.warn = (...a: any[]) => { push('warn', a); orig.warn(...a); };
  console.error = (...a: any[]) => { push('error', a); orig.error(...a); };
  return {
    logs,
    restore: () => {
      console.log = orig.log;
      console.info = orig.info;
      console.warn = orig.warn;
      console.error = orig.error;
    },
  };
}

// One-liner for API handlers: call attachLogCapture(res) as the first line of
// the handler. It starts capturing console output and wraps res.json so that
// every JSON response automatically gets a `logs` array and console is
// restored — no need to touch each individual return.
export function attachLogCapture(res: any, maxLines = 1500): string[] {
  const cap = createLogCapture(maxLines);
  const origJson = res.json.bind(res);
  res.json = (body: any) => {
    try {
      if (body && typeof body === 'object' && !Array.isArray(body)) body.logs = cap.logs;
    } catch { /* ignore */ }
    cap.restore();
    return origJson(body);
  };
  return cap.logs;
}
