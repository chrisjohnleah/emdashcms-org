# CLAUDE.md

### 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately — don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

### 3. Self-Improvement Loop
- After ANY correction from the user: update `Lessons Learned` section below
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for this project

### 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes — don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding.
- Point at logs, errors, failing tests — then resolve them
- Zero context switching required from the user
- Go fix failing builds without being told how

### 7. Public Repo Discipline
- Every commit is visible to anyone — write code a senior engineer would be proud of
- No debug leftovers, no TODO hacks, no placeholder content, no sloppy comments
- Never commit secrets, .env files, or anything embarrassing
- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`)
- Commit and push iteratively at each completed section

## Task Management

1. **Plan First**: Break work into clear steps before coding
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Run `npm test` and `npm run build` to prove it works
6. **Capture Lessons**: Update Lessons Learned after corrections

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Own the Outcome**: Don't just write code — make sure it works, deploys, and meets the spec.
- **Respect the Constraint**: Everything runs on Cloudflare free tier. Every decision must fit.

## Project Rules

- Astro native API routes only — NOT Hono (Anti-Pattern 1)
- Bindings: `import { env } from 'cloudflare:workers'`
- All pages: `export const prerender = false`
- Rate limiting in D1, not KV (KV = 1K writes/day, too low)
- Fail-closed audit: AI errors = version rejected, never silently published
- 10ms CPU limit: heavy work must be async via Queues
- Stack: Astro 6, Zod/mini, jose, modern-tar, D1, R2, KV (read cache only), Workers AI (`@cf/google/gemma-4-26b-a4b-it`), Queues, Vitest

## Commands

```
npm test              # vitest run
npm run build         # wrangler types && astro check && astro build
npm run dev:worker    # astro build && wrangler dev
npm run db:seed       # apply seeds/dev.sql locally
```

## Lessons Learned

- `wrangler types` must run after any `wrangler.jsonc` change
- Custom `worker.ts` only works after `astro build` — dev needs `npm run dev:worker`
- Use database name `emdashcms-org` not binding name `DB` in wrangler CLI
- `published_at` is nullable in D1 but not in contract — coalesce: `row.published_at ?? row.created_at`
- `imageAuditVerdict` is always `null` until v2
- Queue `emdashcms-audit` must be created before first deploy
- Schema alignment needed 14 extra columns the initial migration missed
- STACK.md recommended Hono but ARCHITECTURE.md research overruled it — always verify against codebase
- .planning/ and .vscode/ must stay in .gitignore — were accidentally committed early on
