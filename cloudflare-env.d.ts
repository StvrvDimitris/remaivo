/* eslint-disable */
// Worker environment shared by every Remaivo deployment (wrangler.jsonc, a
// private wrangler.cloudflare.jsonc copy of it, wrangler.selfhost.jsonc). Kept
// by hand so the type covers every config; secrets are optional.
interface __BaseEnv_Env {
	DB: D1Database;
	LOGIN_RATE_LIMIT: RateLimit;
	FINANCE_RATE_LIMIT: RateLimit;
	PAGE_RATE_LIMIT: RateLimit;
	ASSETS: Fetcher;
	REMAIVO_PLATFORM: "cloudflare" | "selfhost";
	APP_ORIGIN?: string;
	REMAIVO_PASSWORD?: string;
	REMAIVO_NAME?: string;
}
declare namespace Cloudflare {
	interface GlobalProps {
		mainModule: typeof import("./worker/index");
	}
	interface Env extends __BaseEnv_Env {}
}
interface Env extends __BaseEnv_Env {}
