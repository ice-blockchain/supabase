# review

Review all changes made today across all benches, modules, and packages with a strict second-pass audit.

Your tasks:
1. Inspect every changed area for:
   - unused, dead, obsolete, disabled, or partially removed code
   - missing cleanup after refactors
   - broken or incomplete integrations
   - missing edge-case handling
   - regressions caused by the recent changes

2. Remove any code that is no longer needed.

3. Check unit tests across all affected areas:
   - add missing tests required by the new changes
   - fix tests that are now broken
   - remove or update outdated tests
   - verify the test suite still matches the intended behavior

4. Review the main architecture files and every package/module Architecture file:
   - update any file that is outdated
   - ensure documentation matches the current implementation exactly
   - fix inconsistencies between architecture docs and code

Execution rules:
- Do not stop at the first pass.
- After making fixes, restart the review from the beginning and re-check everything again.
- Continue iterating until there is nothing left to fix, clean up, update, or align.
- Stop only when the code, tests, and architecture documentation are all fully consistent and complete.