/* eslint-disable @typescript-eslint/no-empty-object-type */
interface PaceEnvironment {
  DB: D1Database;
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
  interface Env extends PaceEnvironment {}
  namespace Cloudflare {
    interface Env extends PaceEnvironment {}
  }
}

export {};
