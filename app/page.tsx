import { signInPath, signOutPath, getUser } from "./auth";
import { RemaivoV3 as FinanceClient } from "./v3-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const authenticatedUser = await getUser();

  if (!authenticatedUser) {
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <span className="signin-logo remaivo-logo-mark" aria-hidden="true" />
          <p className="eyebrow">REMAIVO PERSONAL FINANCE</p>
          <h1>Know what’s left.</h1>
          <p>Sign in securely to see your private accounts, budgets, plans, and progress on every device.</p>
          <a className="primary-button signin-button" href={signInPath("/")}>Sign in <span>→</span></a>
          <small>Your financial data stays on your own Remaivo server.</small>
        </section>
      </main>
    );
  }

  return (
    <FinanceClient
      displayName={authenticatedUser.displayName}
      // A password-only owner has no real address to show.
      email={authenticatedUser.email.endsWith("@remaivo.local") ? "" : authenticatedUser.email}
      signOutHref={signOutPath()}
    />
  );
}
