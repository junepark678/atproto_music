# Project agent guidance

## Current work

Complete the remaining UI work in milestone M7, then finish the backend. Check `docs/MILESTONE_STATUS.md`, the current Node milestone records, and `docs/planning/` before choosing tasks; the status document explicitly distinguishes historical Workers evidence from current Node acceptance. Treat the existing working tree as user work: inspect diffs first, preserve unrelated edits, and do not reset or overwrite them.

## Orchestration preferences

Use the T3 orchestration tools for delegated work. Confirm available providers/models with `orchestrator_capabilities` before the first delegated task in a thread.

### Frontend / UI

- Planning and design direction: Claude Opus 5.5 (`claudeAgent`, model `claude-opus-5-5`).
- Set Opus reasoning effort to `low` for frontend work.
- Implementation: GPT-6 Luna (`codex`, model `gpt-6-luna`).
- Claude Sonnet 5.5 (`claude-sonnet-5-5`) may be used only if Opus explicitly routes a bounded task to it; Opus is the frontend lead.

### Backend

- Technical lead / middle layer between planning and implementation: GPT-6.1 Sol (`codex`, model `gpt-6.1-sol`). Do not use the inherited Codex model as a substitute for this backend lead.
- Planning: Claude Opus 5.5 (`claudeAgent`, model `claude-opus-5-5`).
- Implementation: GPT-6 Luna (`codex`, model `gpt-6-luna`).
- Sol coordinates backend plans, decomposes work for Luna, and reconciles implementation results with Opus's direction.

## Execution and source control

- Keep tasks scoped to the milestone and current architecture; cite concrete files and acceptance criteria in delegation briefs.
- Commit frequently in small, coherent commits. Stage only files belonging to that change; never include unrelated pre-existing worktree changes.
- Push meaningful commits as they are ready, even while the overall implementation is still in progress. Do not wait for the full milestone or backend work to be complete before pushing a completed, reviewable change.
- Preserve user changes and coordinate shared-checkout edits to avoid overwriting another agent's work.
- Report what was completed, what remains, and the evidence used to verify it.
