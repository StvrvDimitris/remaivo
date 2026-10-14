# Set up Remaivo on Cloudflare (free)

This guide is for anyone, no technical knowledge needed. It takes about 10 minutes. At the end you have your own private Remaivo at an address like `remaivo.yourname.workers.dev` that works on your computer and your phone.

**Cost:** free. Cloudflare's free plan easily covers one person.

## What you need

- A free **GitHub** account: <https://github.com/signup>. Cloudflare keeps your copy of Remaivo there.
- A free **Cloudflare** account: <https://dash.cloudflare.com/sign-up>.

## 1. Click the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/StvrvDimitris/remaivo)

1. Sign in to Cloudflare if it asks.
2. Connect your GitHub account when asked. Cloudflare creates a copy of Remaivo in it.
3. Keep the suggested names. If you see `REMAIVO_PASSWORD` or `REMAIVO_NAME`, leave them empty: you'll choose your password in the app.
4. Press **Deploy** (or **Create and deploy**) and wait a few minutes until it says it's done.

## 2. Open your Remaivo

Cloudflare shows your new address when it finishes. You can always find it again in the [Cloudflare dashboard](https://dash.cloudflare.com/) under **Workers & Pages → remaivo**: the link ends in `.workers.dev`.

Open it. You'll see **Welcome to Remaivo**:

![The first visit asks for a setup code and your new password](screenshots/first-visit-password.png)

## 3. Get your setup code

Your address is public on the internet, so to make sure **you** are the one choosing the password, Remaivo asks for a one-time setup code that only you can see:

1. In another browser tab, open the [Cloudflare dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **remaivo**.
2. Open the **Logs** tab and turn on **Live** (sometimes called *Begin log stream*).
3. Go back to the Remaivo tab and **reload** the page.
4. In the logs, a line appears: `Remaivo setup code: ABCD-EFGH`. Copy that code.

## 4. Choose your password

Back in Remaivo, type the setup code, your name (optional), and a password you'll remember (at least 8 characters), twice. Press **Set password**. The code is used up; from now on you just sign in with your password.

## 5. Tell Remaivo where your money is today

A short setup walks you through four steps:

![The setup wizard](screenshots/first-run-setup.png)

1. **Basics:** language (English or Greek), currency, timezone and first day of the week.
2. **Accounts:** add where your money is right now, with today's balances: bank accounts, savings, cash, credit cards (enter what you owe), investments.
3. **Plan:** choose **Track and plan** to get a monthly (or payday/weekly) spending target with daily guidance, or **Track only** to just record money in and out. You can switch later in Settings.
4. **Review**, then **Open Remaivo**.

That's it.

## Put it on your phone

Open your Remaivo address on your phone and sign in. Then:

- **iPhone (Safari):** Share button → **Add to Home Screen**.
- **Android (Chrome):** menu ⋮ → **Add to Home screen** or **Install app**.

It then opens like an app.

## Everyday questions

**I forgot my password.** In the Cloudflare dashboard open **Storage & Databases → D1 → remaivo → Console**, run `DELETE FROM auth_password;` and press Execute. Your finance data is untouched. Open Remaivo again and choose a new password with a fresh setup code (step 3).

**How do I back up my data?** In Remaivo open **Settings** and use **Export**. You get a file with all your records. Cloudflare also keeps its own backups of the database (D1 Time Travel).

**How do I get updates?** When a new version appears on the [releases page](https://github.com/StvrvDimitris/remaivo/releases), update your copy on GitHub: open it, and if GitHub offers **Sync fork**, press it. Cloudflare rebuilds and redeploys automatically after your copy changes, and Remaivo updates its database by itself.

**Can someone else use my Remaivo?** Anyone with the password sees the same data, so share it only with someone you share finances with. For separate finances, each person sets up their own Remaivo.

**Does Cloudflare see my data?** Your data is stored in your own Cloudflare account's database. Nobody else, including the Remaivo developers, has access to it.

## Something went wrong?

- **"Too many requests"**: wait a minute and try again. Remaivo limits sign-in attempts to protect you.
- **"Remaivo is updating its database"**: wait a few seconds and reload.
- **No setup code in the logs**: make sure Live logs are on *before* you reload the Remaivo page.
- Still stuck? [Open an issue](https://github.com/StvrvDimitris/remaivo/issues) and describe what you see.

More technical details: [cloudflare/README.md](../cloudflare/README.md).
