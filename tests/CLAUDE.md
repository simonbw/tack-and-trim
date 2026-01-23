# E2E Testing Guidelines

## Philosophy

E2E tests are inherently slow due to:

- Browser startup overhead
- Game initialization (WebGPU setup, asset loading, influence field propagation)
- Network and rendering latency

Because of this, we follow a **"fat test"** philosophy rather than a unit-test-style approach:

- **Prefer fewer tests with more assertions** over many isolated single-assertion tests
- Each test should verify multiple related behaviors once the expensive setup is done
- Group assertions that share the same preconditions into a single test

This keeps the test suite fast while still providing meaningful coverage.

## When to Add a New Test vs. Extending an Existing One

**Extend an existing test when:**

- The new assertion shares the same setup (e.g., game needs to be initialized and running)
- It's testing a related aspect of the same flow

**Create a new test when:**

- It requires fundamentally different setup (e.g., testing the editor vs. the game)
- The test name would become confusing if you added more assertions

## Test Structure

Each test should:

1. Set up error/warning collection early
2. Perform the minimal setup needed
3. Make multiple assertions with clear comments explaining what each checks
4. Log useful diagnostic info (e.g., timing data) for debugging

## Running Tests

- `npm test` - Run E2E tests (excludes benchmarks)
- `npm run benchmark` - Run performance benchmarks (separate config, multiple iterations)
