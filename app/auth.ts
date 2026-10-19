import { headers } from "next/headers";
import { normalizeUITheme } from "./ui-themes";

// The Worker verifies the owner's session and forwards the identity as headers.
// It removes any identity headers a caller supplies, so only it can set them.
export async function getUser() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("x-remaivo-user-id");
  const email = requestHeaders.get("x-remaivo-user-email");
  if (!userId || !email) return null;
  const displayName = decodeURIComponent(requestHeaders.get("x-remaivo-user-name") ?? "") || email;
  let avatar: { color?: string; icon?: string } = {};
  try { avatar = JSON.parse(decodeURIComponent(requestHeaders.get("x-remaivo-user-avatar") ?? "{}")); } catch { /* the initial on a neutral badge */ }
  return { userId, email, displayName, fullName: displayName, avatar };
}
// The theme this browser last showed, so pages start in it instead of
// flashing the light theme while the profile loads.
export async function savedTheme() {
  const cookie = (await headers()).get("cookie") ?? "";
  return normalizeUITheme(cookie.match(/(?:^|;\s*)rmv-theme=([a-z]+)/)?.[1]);
}
export const signInPath = (returnTo: string) => `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
export const signOutPath = () => "/auth/signout";
export const profilesPath = () => "/auth/profiles";
