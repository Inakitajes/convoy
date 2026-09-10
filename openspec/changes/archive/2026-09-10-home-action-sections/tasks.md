## 1. Home detail sections

- [x] 1.1 Split the detail actions into Sessions, Runs, git, and OpenSpec sections and rename Execute pipeline → New run and Close review → Close (archive & merge); verify the home-tui section-order test passes
- [x] 1.2 Render the always-present New run action inline in the Runs header above the recent-runs list; verify the section and runs tests pass
- [x] 1.3 Add the Archive change action to the OpenSpec section and resolve it as a work action; verify the home-tui action test passes

## 2. Explicit archive

- [x] 2.1 Add the change picker and wire Home's archive action to select a change then run the guarded archive with a notice; verify the change-picker and home-tui tests pass
- [x] 2.2 Offer Archive change in the specs browser Actions menu for the selected change; verify the specs-actions-menu tests pass

## 3. Verification

- [x] 3.1 Run `bun run typecheck`, the affected test files, and `openspec validate home-action-sections --strict`; verify all pass
