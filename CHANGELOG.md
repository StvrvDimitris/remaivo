# Changelog

## 1.0.0 (2026-10-14)

The first public release. Remaivo is a single-owner personal finance app you run yourself, on Cloudflare (free) or with Docker.

**Running your own**
- Deploy to Cloudflare in one click, or run the Docker image on Render, a home server, a NAS or a Raspberry Pi (amd64 and arm64).
- One owner, one password. You choose it on your first visit with a one-time setup code from the server's logs, so a fresh public address can't be claimed by someone else. A `REMAIVO_PASSWORD` setting can be used instead.
- The database updates itself on startup; no migration commands.
- Step-by-step guides for first-timers: [Cloudflare](docs/setup-cloudflare.md) and [Docker](docs/setup-docker.md).

**In the app**
- Accounts with opening balances and balance adjustments; credit cards entered as the amount owed.
- Activity with search, filters, transfers, savings and investment contributions.
- An optional spending Plan (monthly, payday, weekly or fortnightly) with adaptive, even or weighted pacing, daily and weekly allowances, and buckets that cover several categories.
- Scheduled payments: repeating every N days/weeks/months/years, one-off payments, pay-later installments, reschedule, skip (with confirmation) and record with the actual amount paid.
- Track only mode for recording money in and out without a plan.
- Insights with range-aware comparisons, and an Accounts report with a net worth bridge.
- Savings goals, investment valuations and a spare-change round-up.
- Archive manager, JSON export, English and Greek, light and dark themes, and a phone layout that installs to the home screen.
