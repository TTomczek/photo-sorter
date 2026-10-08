# Development values

This guide applies to all coding agents working on Photo Sorter. Use `docs/HANDOFF.md` as the product and architecture reference; preserve its safety invariants when implementing or changing behavior.

## Performance

- Keep scanning, navigation, and review responsive for libraries of up to 200,000 items.
- Use progressive indexing, bounded API pagination, and UI virtualization rather than loading an entire library into browser memory.
- Add or update a measured load/performance check for changes that can affect large-library behavior. Test the 200,000-item target and its bounded-memory/navigation expectations; use observed baselines rather than inventing arbitrary timing limits.

## Intuitive handling

- Make the main workflows clear and predictable across desktop and phone-sized screens.
- Show scan progress and meaningful status; explain errors in actionable language, especially when work is incomplete.
- Make consequential actions deliberate: show what will happen before applying changes, require the specified confirmation, and make LAN security warnings visible where relevant.
- Prefer consistent interactions and preserve user decisions and history when files or roots become unavailable or change.

## Simplicity

- Choose the simplest design that satisfies the product, safety, and performance requirements.
- Prefer clear, focused modules and existing project patterns over unnecessary abstractions, dependencies, or duplicated logic.
- Keep boundaries explicit: filesystem access belongs to the trusted host, and clients must operate only within registered roots.

## Thorough automated testing

- Add or update focused automated tests for changed behavior. Cover relevant normal paths, edge cases, and failure paths—not only the happy path.
- Test file-safety behavior, including that originals are never permanently deleted or overwritten, paths remain within registered roots, and partial apply failures are reported accurately.
- Use unit tests for domain and file-safety logic, end-to-end tests for complete workflows, and browser tests for user-visible interactions where applicable.
- For performance-sensitive changes, include a measured large-library check; preserve coverage for the 200,000-item target, virtualization, and bounded pagination.
- Run the relevant existing test suites and keep them passing in CI.
- Add Regression tests for any bugs that are fixed, and include a description of the failure in the test name or comments.

## Product and data safety

- Keep the application local-first; do not introduce cloud or public-internet dependencies as a requirement for core workflows.
- Never permanently delete or overwrite original media. Apply moves only after explicit confirmation, and preserve recovery and audit information.
- Enforce registered-root boundaries and validate paths on the trusted host; never trust arbitrary client-supplied filesystem paths.
- Surface partial failures clearly. Do not report an operation as successful when some of its work failed.
