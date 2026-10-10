// Global page errors fail the lane independently of its named assertions.
// Called before check.json is written, so its verdict and CLI exit agree.
export function p9CheckResult(failures, errors) {
  const passed = failures.length === 0 && errors.length === 0;
  return {
    verdict: { complete: true, passed },
    failures: [...failures], errors: errors.slice(0, 20), pageErrorCount: errors.length,
    exitCode: passed ? 0 : 1,
    summary: passed ? 'all passed' : `${failures.length} named assertions failed; ${errors.length} page errors`,
  };
}
