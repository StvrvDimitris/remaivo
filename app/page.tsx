import { signInPath, signOutPath, profilesPath, getUser, savedLanguage, savedTheme } from "./auth";
import { translate } from "./ui-language";
import { RemaivoV3 as FinanceClient } from "./v3-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const authenticatedUser = await getUser();

  if (!authenticatedUser) {
    const language = await savedLanguage();
    const tr = (text: string) => translate(text, language);
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <span className="signin-logo remaivo-logo-mark" aria-hidden="true" />
          <p className="eyebrow">{tr("REMAIVO PERSONAL FINANCE")}</p>
          <h1>{tr("Know what’s left.")}</h1>
          <p>{tr("Sign in securely to see your private accounts, budgets, plans, and progress on every device.")}</p>
          <a className="primary-button signin-button" href={signInPath("/")}>{tr("Sign in")} <span>→</span></a>
          <small>{tr("Your financial data stays on your own Remaivo server.")}</small>
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
      profilesHref={profilesPath()}
      avatar={authenticatedUser.avatar}
      initialTheme={await savedTheme()}
    />
  );
}
