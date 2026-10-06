# ScamDecoy Private Monitor

The monitoring service lives in `monitor.js` and is intentionally separate from the public ScamDecoy website.

## Required environment variables

Set these as deployment secrets/environment variables. Do **not** commit real values to GitHub.

```text
MONITOR_PORT=10001
MONITOR_USER=<your-private-username>
MONITOR_PASSWORD=<your-private-password>
MONITOR_MAX_EVENTS=5000
```

## Run

```bash
npm run monitor
```

The monitor exposes:

- `/` — private monitoring dashboard
- `/health` — monitor health
- `/stats` — current monitor statistics
- `/events` — recent monitor events

Authentication is HTTP Basic Authentication and is required for every route.

## Important

`monitor.js` is the monitoring engine/dashboard. The existing `server.js` must be explicitly wired to call `callStarted`, `callCompleted`, `recordError`, `recordApiError`, and `recordStreamError` before the dashboard can display live ScamDecoy call activity.

No production call-server code is changed by the monitor itself.