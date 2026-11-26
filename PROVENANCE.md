# Provenance

This repository is a public copy of selected files from a private repository. It has fresh history because the private history contains account details and personal notes.

| | |
|---|---|
| Source revision | `822c608`, app version 0.18.10 |
| Private history at that revision | 658 commits, 2026-06-11 to 2026-10-10 |
| Project files published | 405 |

Files were read from the committed revision with `git archive`, then passed through a scripted allowlist, redaction and deny-list check.

## Files written for this copy

- `README.md`, `PROVENANCE.md`, `.gitleaks.toml`, `.gitattributes`, `.github/workflows/ci.yml`
- `docs/images`, captured from this copy running in a browser on sample data
- The stub halves of the four modules below

Everything else is project code.

## Stubbed modules

`claude_usage.rs`, `codex_usage.rs`, `cursor_usage.rs` and `openai_billing.rs` read usage meters from vendors through sign-ins that belong to other tools, or through unpublished endpoints. The vendor-specific halves are replaced with stubs. Public types, command names and error paths are unchanged, so every caller compiles as it did.

## Left out

- Internal documents, agent instruction files and research notes
- Scratch scripts for screenshots and one-off diagnosis
- `scripts/research-scan.cjs`, `scripts/fetch-transcript.cjs`, their helper, source list and two tests, which capture video transcripts. The research watch ([`research_watch.rs`](src-tauri/src/research_watch.rs)) calls the first one and reports that it was not found in this copy
- Generated Tauri schemas and build output

## Changed

- Identities in fixtures and in the account gate are placeholder addresses at `example.com`. Session identifiers, note names, a city and a creator's name are placeholders too.
- The sample brain graph uses neutral names and descriptions for personal areas and documents. Its structure is unchanged.
- The home directory in hard-coded paths is the placeholder `C:/Users/dev`, and the web search user agent is `Praxis/0.18 (desktop web search)`.
- User-visible text that quoted a vendor's refusal message is shortened, and the one Rust test that asserted the quoted wording is removed.
- Dictated-message fixtures are replaced with neutral sentences of the same shape. One test URL is assembled with `concat!` so that secret scanners do not report it.
- Comments that named accounts, plans, prices or places are removed, as are quoted remarks. The author's first name is replaced in comments; it remains in prompts, interface strings, identifiers and test fixtures.
- The sidecar README has a generic path and a shorter introduction, and `package.json` has a rewritten description.
- Personal file names in `org_scan.rs` are placeholders, and plan names are removed from the planner prompt in `buildChain.ts`.
- One memory-recall test sets file times explicitly. It relied on files written in a loop having different modification times, which a fast disk does not guarantee.
- Em dashes in Rust and TypeScript comments are normalised to hyphens.

## Verification

Run on this copy on Windows 11:

| Command | Result |
|---|---|
| `cargo test --lib` | 418 passed, 14 ignored |
| `scripts/test-*.cjs` | 38 of 38 suites passed |
| `npm run build` | type-check and bundle completed |
