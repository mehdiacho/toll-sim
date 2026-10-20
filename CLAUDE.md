# toll-sim

Read `docs/HANDOFF.md` first: where everything lives, local run commands, NAS hosting and deploy, decisions so far, and next steps. The Unreal v2 client is `X:\Projects\toll-sim-unreal` (its own `docs/HANDOFF.md`).

- Commit as `mehdiacho <mehdiacho@gmail.com>`. No `Co-Authored-By`, AI trailers or "Generated with" lines, and no model names in commits or code.
- CI must be green before pushing to `main`; run `npm run typecheck` and `npm test` first.
- Never commit or print secrets (the NAS `.env` stays on the NAS). Downloads, portfolio merges and Cloudflare DNS or tunnel changes need Mehdi's own OK.
- Update `docs/HANDOFF.md` in the same commit as any milestone.
