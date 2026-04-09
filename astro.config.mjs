// @ts-check
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  adapter: cloudflare({
    // Disable remote-binding dispatch during local builds. The deploy
    // pipeline runs `astro build` against the real account; in dev and
    // CI worktrees we don't have an active CLOUDFLARE_ACCOUNT_ID and the
    // remote proxy session would otherwise fail with `accounts/test`.
    remoteBindings: false,
  }),
  site: 'https://emdashcms.org',
});
