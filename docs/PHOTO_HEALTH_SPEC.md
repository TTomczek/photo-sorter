# Photo Health Feature Specification

## Purpose

Add a Photo Health workflow for finding duplicate photos, exact duplicate videos, and clearly blurry photos. It should help users review findings efficiently without changing the app's existing file-safety guarantees.

This specification records the decisions confirmed in the product interview on 2026-10-09. Use it with `docs/HANDOFF.md`; the handoff's product and safety invariants remain authoritative.

## Product decisions

### Scope and analysis

- Photo Health is scoped to the selected collection. Do not match files across collections.
- Run analysis in the background, with visible progress and collection-wide pause/resume state shared across devices.
- Backfill already-indexed media when Photo Health is enabled. Analyze new and changed media as it is indexed.
- Analyze all indexed still-image formats where possible. Do not run blur detection on videos. If an analyzer cannot read a recognized format, report that clearly rather than silently treating it as analyzed.
- Duplicate matching:
  - Find exact duplicates.
  - Also find visually similar photo copies that preserve essentially the same framing/content, including resized or recompressed copies.
  - Do not group crops, edits, or burst shots as near-duplicates.
  - For video, find exact-file duplicates only; do not use visual similarity matching.
- Blur detection should flag only clearly out-of-focus or motion-blurred photos. Sensitivity tuning is deferred.

### Review experience

- Add **Photo Health** as its own navigation entry alongside the existing Review and Browse workflows.
- Present duplicate and blur findings in one combined review queue, with filters for finding type.
- Show the reason for each finding and a confidence/strength indicator where available.
- Duplicate groups have a synchronized side-by-side comparison with file details, zoom, and pan.
- A photo found in both a duplicate group and the blur filter appears in both, but its decision is shared and consistent across views.
- For a duplicate group, let the user choose one or more photos to keep. Stage the other group members as Deleted using the existing decision system.
- For a blurry photo, offer deliberate per-photo Keep, Unsure, and Deleted decisions.
- Hide handled findings by default and provide a way to revisit them. Unsure is considered handled in Photo Health but remains accessible through its filter.
- Do not change files as a consequence of reviewing a finding. Moving files still requires the existing apply summary and second explicit confirmation.

## Safety and performance requirements

- Preserve all invariants in `docs/HANDOFF.md`: never permanently delete or overwrite originals; enforce registered-root boundaries on the host; report partial failures accurately; and keep file operations behind the existing confirmed apply/restore workflow.
- Keep background analysis bounded and responsive for collections of up to 200,000 items. Do not load the collection's full media or finding set into browser memory. Reuse progressive indexing, bounded API pagination, and virtualized UI patterns.
- Keep Photo Health usable while analysis is running or paused, and make unsupported media and analysis failures visible.
- Store and access findings within the existing collection and item boundaries. Follow existing persistence, audit, authentication, and local-first architecture patterns.

## Acceptance coverage

- Verify exact duplicate matching, supported visually similar photo copies, excluded crops/edits/burst shots, exact-file video matching, and blur findings for clearly out-of-focus or motion-blurred photos.
- Verify results are collection-scoped; analysis backfills existing indexed media and picks up new or changed media.
- Verify progress and pause/resume state are visible and consistent across devices.
- Verify group decisions stage the expected Keep/Deleted decisions, blur actions support Keep/Unsure/Deleted, and overlapping findings share one decision.
- Verify handled results are hidden by default and can be revisited, including Unsure findings.
- Verify that review never moves or deletes files, and existing double-confirmed apply/restore safety is unchanged.
- Add focused regression tests for unsupported/unreadable media and analysis failures.
- For the large-library path, measure behavior with the existing 200,000-item target and confirm bounded pagination, bounded browser rendering/memory, and virtualized navigation.
