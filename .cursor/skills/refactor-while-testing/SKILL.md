---
name: refactor-while-testing
description: When writing or reviewing tests for specific code, evaluate the code under test for clean code refactoring opportunities. Use when adding tests, writing unit tests, reviewing test files, or when the user asks to test a specific function or module.
---

# Refactor While Testing

When writing or reviewing tests for a piece of code, treat it as a refactoring checkpoint. Tests give you the safety net to simplify — use it.

## Workflow

1. **Read the code under test thoroughly** before writing any test
2. **Write the tests first** — confirm existing behaviour passes
3. **Evaluate refactoring opportunities** using the checklist below
4. **Propose changes** to the user before applying (unless trivial)
5. **Refactor, then re-run tests** to confirm nothing broke

## Refactoring Checklist

For every function or module you're testing, ask:

### Complexity
- Can a long function be split into smaller, single-responsibility helpers?
- Are there nested `if`/`match` chains that could be early returns?
- Can a `match` with many arms be replaced with a lookup table or map?

### Naming
- Do function names describe *what* they return, not *how* they work?
- Are variable names self-documenting (no `x`, `tmp`, `val`)?
- Would renaming eliminate the need for a comment?

### Duplication
- Is there repeated logic across functions that could be extracted?
- Are there near-identical code blocks differing by one parameter?

### Abstraction
- Is a function doing two unrelated things (violating SRP)?
- Could a data transformation pipeline replace imperative mutation?
- Would introducing a type/struct make the API clearer?

### Dead code
- Are there unreachable branches, unused parameters, or stale imports?
- Is there commented-out code that should be deleted?

## What NOT to refactor

- Don't refactor code you're not testing (stay in scope)
- Don't rename public API surfaces without the user's approval
- Don't change behaviour — only structure
- Don't optimise for performance unless there's a measured problem
- Don't add abstraction layers that make the code harder to follow

## Output format

When you find a refactoring opportunity, present it as:

```
Refactoring opportunity in `function_name`:
- Current: [brief description of the smell]
- Proposed: [what to change]
- Why: [which clean code principle it improves]
- Risk: low/medium (does it touch public API or just internals?)
```

Then apply it only after the user agrees, or if it's trivial (removing dead code, fixing a name, extracting a 2-line helper).
