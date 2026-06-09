/**
 * harness.ts — 最小测试框架（零外部依赖）
 *
 * 用法:
 *   const suite = new TestSuite('My Suite');
 *   suite.test('should do X', () => { assert(1 + 1 === 2, 'math broke'); });
 *   suite.run();
 */

export class TestSuite {
  private tests: { name: string; fn: () => void | Promise<void> }[] = [];
  private passed = 0;
  private failed = 0;
  private errors: string[] = [];

  constructor(private readonly suiteName: string) {}

  test(name: string, fn: () => void | Promise<void>): void {
    this.tests.push({ name, fn });
  }

  async run(): Promise<boolean> {
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`  ${this.suiteName}`);
    console.log(`${'═'.repeat(60)}`);

    for (const { name, fn } of this.tests) {
      try {
        await fn();
        this.passed++;
        console.log(`  ✓ ${name}`);
      } catch (err) {
        this.failed++;
        const msg = err instanceof Error ? err.message : String(err);
        this.errors.push(`  ✗ ${name}\n    ${msg}`);
        console.log(`  ✗ ${name}`);
        console.log(`    ${msg}`);
      }
    }

    console.log(`\n  ${this.passed} passed, ${this.failed} failed\n`);
    return this.failed === 0;
  }

  get summary(): string {
    if (this.failed === 0) return `All ${this.passed} tests passed.`;
    return `${this.failed}/${this.passed + this.failed} failed:\n${this.errors.join('\n')}`;
  }
}

/**
 * Assertion helper. Throws on failure.
 */
export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

export function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

export function assertDeepEq(actual: unknown, expected: unknown, label: string): void {
  assertEq(actual, expected, label);
}

export function assertThrows(fn: () => void, expectedMsg?: string, label?: string): void {
  try {
    fn();
    throw new Error(`${label ?? 'assertThrows'}: expected error but none was thrown`);
  } catch (err) {
    if (expectedMsg && err instanceof Error && !err.message.includes(expectedMsg)) {
      throw new Error(
        `${label ?? 'assertThrows'}: expected message containing "${expectedMsg}", got "${err.message}"`,
      );
    }
  }
}

export function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`${label}: expected string to contain "${needle}", got "${haystack.slice(0, 200)}"`);
  }
}
