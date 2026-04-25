# IGNORE UNIT TESTS COMPLETELY

Unit tests in this repository are out of date and should not be used as a correctness signal for the active memory redesign work.

For this effort:

- do not rely on unit tests
- do not treat unit test failures as authoritative
- validate with live E2E runs against the real backend instead
- inspect logs and persisted state as the primary verification method
