# Pool Heat Manager

An AI-assisted agent that automates pool heating for short-term rentals. It watches your guest messages for pool-heat agreements, models how long the pool needs to heat given the weather forecast, turns the heater on at the right moment, and turns it off when the paid heat window ends.

Built for a real 3-pool STR operation in Virginia, running in production since March 2026.

**Live demo:** https://pool-heat-demo.netlify.app

## How it works

1. **Monitor** — polls the Hostaway API every 4 hours (plus a real-time webhook) for guest conversations.
2. **Detect** — scans messages for the host's pool-heat offer and the guest's reply. Clear agreements are parsed for the number of heat days ("3 days", "Wed to Fri", …). Ambiguous replies trigger a one-click classification email to the host — the agent never guesses.
3. **Model** — pulls the Open-Meteo forecast and forward-simulates pool temperature: idle cooling until the heater starts, then heating with conservative net-rate assumptions. Picks the latest start time that still hits the target temp by check-in.
4. **Actuate** — connects to the Pentair ScreenLogic gateway, updates the heat schedule, and sets the pool body. Turns the heater off at 8 PM on the last paid heat day.
5. **Self-check** — recalculates at T-24h and T-12h as the forecast evolves, and does a weather-independent sanity read at T-6h that panic-starts the heater if the pool is off-track. Alerts go out by email (Resend) and SMS (Twilio).

Target temperature is seasonal (80–84°F depending on month), matching a per-day pricing schedule.

## Architecture

| File | Role |
|------|------|
| `src/index.ts` | Express server — webhook listener, health, manual scan, schedule inspection |
| `src/scheduler.ts` | Cron scheduler, RECALCULATE/SANITY_READ events, heater ON/OFF execution, disk persistence |
| `src/hostaway.ts` | Hostaway API client, message scanning, agreement detection |
| `src/screenlogic.ts` | Pentair ScreenLogic control (read temps, set heat, update schedules) |
| `src/weather.ts` | Open-Meteo forecasts + thermodynamic heat-up simulation |
| `src/pricing.ts` | Season-based target temps and pricing |
| `src/confirm.ts` | Host classification emails for ambiguous guest replies |
| `src/override.ts` | One-click email overrides (delay heater start) |
| `src/digest.ts` | Twice-weekly booking digest |
| `src/alerts.ts` / `src/sms.ts` | Resend email + Twilio SMS alerts |
| `src/config.ts` | Env + property configuration loading |

State (scheduled events, host classifications) persists to `data/*.json` so restarts don't lose pending heater actions.

## Setup

```bash
git clone https://github.com/kylehawke-stack/pool-heat-manager.git
cd pool-heat-manager
npm install

# Configure credentials
cp .env.example .env          # API keys: Hostaway, Pentair, Resend, Twilio

# Configure your properties (listing IDs, gateway names, coordinates)
cp properties.example.json properties.json
```

`properties.json` and `.env` are gitignored — your listing IDs, gateway names, and coordinates never leave your machine.

Run locally:

```bash
npx tsx src/index.ts
```

### Deploying

`deploy.sh` rsyncs the project to a server and (re)starts it under PM2. Set your target in a gitignored `.deploy.env`:

```bash
DEPLOY_SERVER=root@your.server.ip
./deploy.sh
```

`.env` and `data/` live only on the server and are never overwritten by deploys.

## Hard-won lessons encoded in this repo

- **Timezones:** all wall-clock math goes through an Intl-based `zonedDate()` helper. Never construct a `Date` from a bare `T20:00:00` string — it parses server-local and once produced a 4-hour offset bug.
- **Pentair ordering:** update the ScreenLogic *schedule* first, then the *body*. The controller re-syncs the body from the schedule; the reverse order silently turns the heater back off.
- **Retry everything:** heater events only mark executed on success (5 attempts max), Open-Meteo calls retry with backoff, and a weather-independent sanity check survives forecast-API outages.
- **Conservative physics:** planning uses ~75% of the empirically observed heat-up rate. A cold pool at check-in costs far more than a few extra hours of propane.

## Contributing

Issues and PRs welcome. Useful directions:

- Support for more heater platforms (Hayward OmniLogic, Jandy iAquaLink)
- Support for more PMS platforms (Guesty, Hospitable, OwnerRez)
- Automated fee collection when a guest agrees to pool heat
- Tests around message parsing and the heat-up simulation

Keep changes small and focused. If you're changing scheduling or heater-control logic, explain the failure mode you're addressing — most of this codebase exists because something real went wrong.

## License

[MIT](LICENSE)
