import vinext from "vinext";
import { defineConfig } from "vite";

// REMAIVO_HOST picks the Worker config at build time:
//   unset        wrangler.jsonc, the template for any Cloudflare deployment
//   "cloudflare" wrangler.cloudflare.jsonc, your own filled-in copy of it (not committed)
//   "selfhost"   wrangler.selfhost.jsonc, the Docker image
const configPath = {
  cloudflare: "./wrangler.cloudflare.jsonc",
  selfhost: "./wrangler.selfhost.jsonc",
}[process.env.REMAIVO_HOST ?? ""] ?? "./wrangler.jsonc";

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      cloudflare({ viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] }, configPath }),
    ],
  };
});
