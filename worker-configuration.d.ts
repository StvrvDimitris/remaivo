/* eslint-disable @typescript-eslint/no-empty-object-type */
interface RemaivoEnvironment {
  DB: D1Database;
  REMAIVO_PURGE_TOKEN?: string;
  REMAIVO_OWNER_USER_ID?: string;
  REMAIVO_PURGE_OTHER_USER_ID?: string;
  ASSETS: Fetcher;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
}

declare global {
  interface Env extends RemaivoEnvironment {}
  namespace Cloudflare {
    interface Env extends RemaivoEnvironment {}
  }
}

export {};
