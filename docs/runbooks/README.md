# Runbooks

There was no runbook directory in this repo before 2026-09-10. This proposes the convention.

A runbook is written for **someone woken at 3am who did not build the thing**. That imposes
the rules below. It is not an ADR (why a decision was made), not a reference (what everything
does) and not onboarding (how the system fits together) — it is one procedure, executed under
pressure, by someone who cannot ask a question.

## Index

| Runbook | Reader | Use when |
|---|---|---|
| [`provision-a-database.md`](provision-a-database.md) | engineer standing up or recovering a Postgres | New vertical database (ADR 0013), control-plane recovery, a throwaway environment, or any `rls:verify` failure |
| [`email-delivery.md`](email-delivery.md) | whoever owns "the invite never arrived" | An invite/reset did not arrive, or you are trying to onboard the first real customer |

## Required of every runbook here

1. **Name the reader and the preconditions in the first three lines.** A procedure that
   assumes access it does not name fails at 3am, not at review.
2. **Exact commands, pasteable.** No `<your-value-here>` where a real command exists, and no
   step that says "investigate".
3. **Expected output for every command**, and a table of what to do when the output differs.
   The divergence table is the part that earns the file.
4. **Say which steps write.** Anything that changes a shared environment is called out as a
   change requiring confirmation, not buried in a code block.
5. **A rollback section.** If the reverse of a step does not exist, say so in the step —
   that is exactly the thing worth knowing before running it, not after.
6. **Escalation by name and role**, ending each path.
7. **Verified claims only.** Every count, hostname and flag is measured, with the date it was
   measured. Anything not confirmable is marked `[UNVERIFIED: <thing>]` or
   `[NEEDS DATA: <thing>]` inline rather than described plausibly. A runbook that is confidently
   wrong at 3am is worse than no runbook.

## Never in a runbook

- **A real credential**, or an example that could be mistaken for one. Synthetic and obviously
  synthetic. Note where a script *prints* a credential (`provision-rls-role.js`,
  `seed-demo.js` both do) so the reader does not pipe it into a log.
- **A production step presented as routine.** Name the environment, name what changes, name
  the rollback.
