# Changelog

## Unreleased

**Tags**
- Sort activity a second way besides categories. In **Settings → Tags**, create your own tag groups, such as *Need* with *Daily* and *Leisure*. Remaivo comes with none.
- Each transaction can carry one tag from each group. Pick them when you add or correct a transaction, a recurring plan or a pay-later plan; scheduled payments pass their plan's tags on to what they post.
- A bucket can cover only tagged purchases, such as *Food, tagged Daily*, so one category can feed two buckets without splitting it into duplicates.
- Filter Activity and Insights by a tag, or by *No tag* in a group, and see how spending splits by tag in Insights.
- Tags and tag groups can be archived and restored from the Archive manager, and backups include them. Older backups still restore.

## 1.3.0 (2026-11-04)

**Backups you can restore**
- **Download backup** in Settings now saves every profile in one file, with each profile's name, colour and icon. Your password isn't included.
- **Restore from a backup** shows the backup's date and what would change for each profile, then asks you to confirm. Your current data downloads first, in case you chose the wrong file.
- A restore replaces only the profiles in the file. If anything goes wrong, nothing changes.
- Earlier exports can still be restored, one profile at a time, and a backup also restores onto a new install.

**Payment calendar**
- **Plan → Upcoming** has a new Calendar view of the current plan period. Each day shows its payments and what your plan expects to have left afterwards, using the same estimate as Budget pace.
- Days turn amber when the plan is running low and red when they go over it. Open a payment to record, reschedule or skip it.

**Phones**
- The Plan tabs are now Allocations, Upcoming and Schedules, so all three fit without scrolling.

**Updating**
- Cloudflare: open your copy on GitHub and press **Sync fork**; Cloudflare redeploys by itself. Render: **Manual Deploy → Deploy latest commit**. At home: run the three update lines from the [Docker guide](docs/setup-docker.md). Your data stays, and nothing needs changing in the database.

## 1.2.0 (2026-11-04)

**Themes**
- Two new themes: **Sand**, warm paper tones with a terracotta accent, and **Obsidian**, a true-black theme for night. Pick them in Settings → Appearance. They also apply to the sign-in and profile pages and the phone's status bar.
- The dark themes no longer use purple. Midnight's links, buttons, icons and chart lines are now sky blue, and Obsidian's are amber.

**Updating**
- Cloudflare: open your copy on GitHub and press **Sync fork**; Cloudflare redeploys by itself. Render: **Manual Deploy → Deploy latest commit**. At home: run the three update lines from the [Docker guide](docs/setup-docker.md). Your data stays, and your chosen theme is kept.

## 1.1.1 (2026-10-20)

**Looks the same everywhere**
- The profile picker, sign-in pages and the installed app now follow your theme (Indigo, Ocean or Midnight), including the phone's status bar and the splash screen. No more green bars, white edges or a white flash when opening the app in dark mode.
- The profile picker uses icon buttons instead of text, and the top-left of the app shows your profile card; tap it to switch profile.
- Leftover greens from the old design are gone.

**Greek**
- The whole interface is now in Greek when Greek is chosen, including sign-in, profiles, statuses, charts, scheduled payments and error messages.

**Phones**
- Side-by-side fields in forms stay aligned when a label wraps, dropdowns get the full width so their choice isn't cut off, and the close button no longer covers fields while you scroll.
- The transaction type tabs no longer overlap in Greek.

**Accounts**
- Bank, wallet and custom accounts call their limit an *overdraft limit*; credit cards keep *credit limit*. Savings, cash and investment accounts no longer show a limit.

**Updating**
- Cloudflare: open your copy on GitHub and press **Sync fork**; Cloudflare redeploys by itself. Render: **Manual Deploy → Deploy latest commit**. At home: run the three update lines from the [Docker guide](docs/setup-docker.md). Your data stays and the database updates itself.

## 1.1.0 (2026-10-19)

**Profiles**
- Share your Remaivo password with up to four other people. After signing in, everyone picks their profile ("Who's using Remaivo?"), and each profile has its own accounts, plans, history and settings.
- A new profile starts with the full setup: opening balances, accounts and an optional plan.
- Profile cards can be customised with a name, a colour and an icon, and edited at any time.
- Switch profile from the sidebar or from Settings, on any device. Switching on one device doesn't affect another.
- Existing sign-ins stay signed in as the owner; the database updates itself.

**Installing**
- Docker and Render installs now build Remaivo from this repository instead of downloading a published image, so they no longer depend on GitHub Actions. Home installs use `docker build` straight from GitHub; see the [Docker guide](docs/setup-docker.md).

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
