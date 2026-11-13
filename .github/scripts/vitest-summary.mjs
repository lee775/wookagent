// Short failure summary of a vitest JSON result for the CI job log (.github/workflows/linux.yml, design 10.10, lead decision S10t).
//   node .github/scripts/vitest-summary.mjs <vitest.json> [--exit-file <file>] [--require-ran]
// Prints the counts, every file that failed without a failed test (load or hook errors), and every failed test with the first lines
// of its message. Exits 1 when anything failed, when the JSON is missing or unreadable, when the exit code in --exit-file is not 0
// (vitest also exits 1 for unhandled errors while every test passed), or with --require-ran when no test passed or a test was
// skipped (a gated real test whose gate stayed closed must not look green). Nothing else is printed: no environment, no file contents.
import { existsSync, readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args[0];
const exitFile = args.includes('--exit-file') ? args[args.indexOf('--exit-file') + 1] : null;
const requireRan = args.includes('--require-ran');
const MAX_FAILED = 80;
const MAX_LINES = 8;

const strip = (s) => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
/** message lines without stack frames inside node_modules or node:internal */
const lines = (s) =>
  strip(s)
    .split('\n')
    .filter((l) => l.trim() && !/^\s*at .*(node_modules|node:internal)/.test(l))
    .slice(0, MAX_LINES);
const rel = (p) => strip(p).replace(/\\/g, '/').replace(/^.*?\/(src|tests)\//, '$1/');
const problems = [];

const exitCode = exitFile && existsSync(exitFile) ? readFileSync(exitFile, 'utf8').trim() : null;
if (exitFile && exitCode === null) problems.push(`no exit code (${exitFile} is missing — the run did not finish)`);
if (exitCode !== null && exitCode !== '0') problems.push(`vitest exit code ${exitCode}`);

let report = null;
if (!file || !existsSync(file)) problems.push(`no JSON result at ${file ?? '(none given)'}`);
else {
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    problems.push(`JSON result unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

if (report) {
  const results = Array.isArray(report.testResults) ? report.testResults : [];
  const n = (k) => Number(report[k] ?? 0);
  console.log(
    `tests: ${n('numTotalTests')} total, ${n('numPassedTests')} passed, ${n('numFailedTests')} failed, ${n('numPendingTests')} skipped, ${n('numTodoTests')} todo; ` +
      `files: ${n('numTotalTestSuites')} suites, ${results.filter((r) => r.status === 'failed').length} files failed`,
  );
  const loadErrors = results.filter((r) => r.status === 'failed' && !(r.assertionResults ?? []).some((a) => a.status === 'failed'));
  if (loadErrors.length) {
    problems.push(`${loadErrors.length} file(s) failed without a failed test`);
    console.log(`\n## files that failed without a failed test (${loadErrors.length})`);
    for (const r of loadErrors) {
      console.log(`- ${rel(r.name)}`);
      for (const line of lines(r.message)) console.log(`    ${line.slice(0, 240)}`);
    }
  }
  const failed = results.flatMap((r) => (r.assertionResults ?? []).filter((a) => a.status === 'failed').map((a) => ({ file: rel(r.name), a })));
  if (failed.length) {
    problems.push(`${failed.length} failed test(s)`);
    const perFile = new Map();
    for (const f of failed) perFile.set(f.file, (perFile.get(f.file) ?? 0) + 1);
    console.log(`\n## failed tests per file (${perFile.size} files)`);
    for (const [f, c] of [...perFile].sort((x, y) => y[1] - x[1])) console.log(`- ${String(c).padStart(3)}  ${f}`);
    console.log(`\n## failed tests (first ${Math.min(failed.length, MAX_FAILED)} of ${failed.length})`);
    for (const { file: f, a } of failed.slice(0, MAX_FAILED)) {
      console.log(`- ${f} :: ${[...(a.ancestorTitles ?? []), a.title].join(' > ').slice(0, 200)}`);
      for (const line of lines((a.failureMessages ?? [''])[0])) console.log(`    ${line.slice(0, 240)}`);
    }
  }
  if (requireRan) {
    if (n('numPassedTests') === 0) problems.push('no test passed (was the gate open?)');
    const skipped = results.flatMap((r) => (r.assertionResults ?? []).filter((a) => a.status !== 'passed' && a.status !== 'failed').map((a) => `${rel(r.name)} :: ${a.title} (${a.status})`));
    if (skipped.length) {
      problems.push(`${skipped.length} test(s) did not run`);
      console.log('\n## tests that did not run');
      for (const s of skipped) console.log(`- ${s.slice(0, 240)}`);
    }
  }
}

if (problems.length) {
  console.log(`\nRESULT: NOT GREEN — ${problems.join('; ')}`);
  process.exit(1);
}
console.log('\nRESULT: green');
