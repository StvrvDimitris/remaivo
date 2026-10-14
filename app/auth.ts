import { headers } from "next/headers";

// The Worker verifies the owner's session and forwards the identity as headers.
// It removes any identity headers a caller supplies, so only it can set them.
export async function getUser() {
  const requestHeaders = await headers();
  const userId = requestHeaders.get("x-remaivo-user-id");
  const email = requestHeaders.get("x-remaivo-user-email");
  if (!userId || !email) return null;
  const displayName = decodeURIComponent(requestHeaders.get("x-remaivo-user-name") ?? "") || email;
  return { userId, email, displayName, fullName: displayName };
}
export const signInPath = (returnTo: string) => `/auth/login?return_to=${encodeURIComponent(returnTo)}`;
export const signOutPath = () => "/auth/signout";
