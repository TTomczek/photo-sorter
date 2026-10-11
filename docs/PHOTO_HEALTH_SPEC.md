# Photo Health Feature Specification

## Purpose

Add a Photo Health workflow for finding duplicate photos and exact duplicate videos. It should help users review findings efficiently without changing the app's existing file-safety guarantees.

This specification records the decisions confirmed in the product interview on 2026-10-09. Use it with `docs/HANDOFF.md`; the handoff's product and safety invariants remain authoritative.

## Product decisions

### Scope and analysis

- Photo Health is scoped to the selected collection. Do not match files across collections.
- Run analysis in the background, with visible progress and collection-wide pause/resume state shared across devices.
- Backfill already-indexed media when Photo Health is enabled. Analyze new and changed media as it is indexed.
- Analyze all indexed still-image formats where possible. If an analyzer cannot read a recognized format, report that clearly rather than silently treating it as analyzed.
- Duplicate matching:
  - Find exact duplicates.
  - Also find visually similar photo copies that preserve essentially the same framing/content, including resized or recompressed copies.
  - Do not group crops, edits, or burst shots as near-duplicates.
  - For video, find exact-file duplicates only; do not use visual similarity matching.

### Review experience

- Add **Photo Health** as its own navigation entry alongside the existing Review and Browse workflows.
- Present duplicate findings in one review queue.
- Show the reason for each finding and a confidence/strength indicator where available.
- Duplicate groups use a side-by-side comparison with file details, zoom, and pan. Order members by case-insensitive relative path.
- Compare the current winner with the next member in the group. Offer only Keep left and Keep right decisions, with left/right arrow and swipe shortcuts selecting the corresponding side.
- Keep decisions staged until the final pair. Then save one winner as Keep and all other group members as Delete automatically. Leaving early discards staged choices; reopening starts from the first pair.
- Allow Undo/Redo through staged comparisons. After completion, treat the entire group as one device-scoped history operation.
- Automatically open the next group after completion and return to the findings list after the last group.
- Hide handled findings by default and provide a way to revisit them.
- After analysis completes, allow an explicitly confirmed full collection reanalysis. Reprocess every present Photo Health item, including previous failures and unsupported files; preserve existing Keep/Delete decisions and retain each old finding until that item is rechecked. Show progress, and do not enable reanalysis while processing is running or paused.
- Do not change files as a consequence of reviewing a finding. Moving files still requires the existing apply summary and second explicit confirmation.

## Safety and performance requirements

- Preserve all invariants in `docs/HANDOFF.md`: never permanently delete or overwrite originals; enforce registered-root boundaries on the host; report partial failures accurately; and keep file operations behind the existing confirmed apply/restore workflow.
- Keep background analysis bounded and responsive for collections of up to 200,000 items. Do not load the collection's full media or finding set into browser memory. Reuse progressive indexing, bounded API pagination, and virtualized UI patterns.
- Keep Photo Health usable while analysis is running or paused, and make unsupported media and analysis failures visible.
- Store and access findings within the existing collection and item boundaries. Follow existing persistence, audit, authentication, and local-first architecture patterns.

## Acceptance coverage

- Verify exact duplicate matching, supported visually similar photo copies, excluded crops/edits/burst shots, and exact-file video matching.
- Verify results are collection-scoped; analysis backfills existing indexed media and picks up new or changed media.
- Verify progress and pause/resume state are visible and consistent across devices.
- Verify pairwise winner progression for groups with more than two members, no saved changes before group completion, and final Keep/Delete decisions.
- Verify leaving an incomplete group discards staged choices, staged Undo/Redo works, and a completed group's Undo/Redo is atomic.
- Verify completed groups automatically advance and the last group returns to findings.
- Verify handled results are hidden by default and can be revisited, including Unsure findings.
- Verify full reanalysis is confirmed, only available after completion, preserves decisions and old findings until each item is processed, and reports progress.
- Verify that review never moves or deletes files, and existing double-confirmed apply/restore safety is unchanged.
- Add focused regression tests for unsupported/unreadable media and analysis failures.
- For the large-library path, measure behavior with the existing 200,000-item target and confirm bounded pagination, bounded browser rendering/memory, and virtualized navigation.
