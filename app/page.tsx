import { chatGPTSignInPath, chatGPTSignOutPath, getChatGPTUser } from "./chatgpt-auth";
import { RemaivoV3 as FinanceClient } from "./v3-client";

export const dynamic = "force-dynamic";

export default async function Home() {
  const authenticatedUser = await getChatGPTUser();
  const isLocalPreview = process.env.NODE_ENV !== "production";

  if (!authenticatedUser && !isLocalPreview) {
    return (
      <main className="signin-screen">
        <section className="signin-card">
          <span className="signin-logo remaivo-logo-mark" aria-hidden="true" />
          <p className="eyebrow">REMAIVO PERSONAL FINANCE</p>
          <h1>Know what’s left.</h1>
          <p>Sign in securely to see your private accounts, budgets, plans, and progress on every device.</p>
          <a className="primary-button signin-button" href={chatGPTSignInPath("/")}>Sign in with ChatGPT <span>→</span></a>
          <small>Your finance data stays connected to this Site and your signed-in account.</small>
        </section>
      </main>
    );
  }

  return (
    <FinanceClient
      displayName={authenticatedUser?.displayName ?? "Alex Morgan"}
      email={authenticatedUser?.email ?? "alex@example.com"}
      signOutHref={authenticatedUser ? chatGPTSignOutPath("/") : "#"}
    />
  );
}
