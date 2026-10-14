import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from "./chatgpt-auth";

// "google" (Cloudflare) and "password" (self-hosted) both authenticate in the
// Worker and forward the verified identity as headers; Sites uses ChatGPT.
const provider = () => env.AUTH_PROVIDER as string | undefined;
export function usesPasswordAuth() { return provider() === "password"; }
export function usesWorkerAuth() { return provider() === "google" || usesPasswordAuth(); }
export async function getUser() {
  if (!usesWorkerAuth()) return getChatGPTUser();
  // Only the Worker can set these headers after verifying an opaque session.
  // Every externally supplied identity header is removed at the Worker boundary.
  const requestHeaders = await headers();
  const userId = requestHeaders.get("x-remaivo-user-id");
  const email = requestHeaders.get("x-remaivo-user-email");
  if (!userId || !email) return null;
  const displayName = decodeURIComponent(requestHeaders.get("x-remaivo-user-name") ?? "") || email;
  return { userId, email, displayName, fullName: displayName };
}
export const signInPath = (returnTo: string) => usesPasswordAuth() ? `/auth/login?return_to=${encodeURIComponent(returnTo)}`
  : usesWorkerAuth() ? `/auth/google?return_to=${encodeURIComponent(returnTo)}` : chatGPTSignInPath(returnTo);
export const signOutPath = (returnTo: string) => usesWorkerAuth() ? "/auth/signout" : chatGPTSignOutPath(returnTo);
