/**
 * F1 wrapper for the vendored family gate.
 *
 * The data repo cannot reach the plugin repo's toolchain from a bare local
 * checkout, so the official verifier is vendored byte-for-byte at
 * `scripts/vendor/verify-plugin.mjs` (provenance in its header). This wrapper
 * runs it against a plugin directory and returns a machine-readable report
 * that the submission workflow embeds verbatim in the PR body.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERIFIER = join(ROOT, 'scripts', 'vendor', 'verify-plugin.mjs');

/**
 * @param {{pluginDir?:string, verifierPath?:string, run?:Function}} options
 * `run` is injectable so tests can exercise both the green and red paths
 * without needing a real plugin checkout.
 */
export function runVerifyPlugin({ pluginDir = '', verifierPath = VERIFIER, run = execFileSync } = {}) {
  const args = [verifierPath, pluginDir];
  const command = `node scripts/vendor/verify-plugin.mjs ${pluginDir}`.trim();
  const base = { command, verifierPath, pluginDir };
  try {
    const stdout = run(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ...base, ok: true, output: String(stdout ?? '').trim() };
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error.message ?? error);
    return { ...base, ok: false, output };
  }
}

export function renderVerifySection(report = null) {
  return [
    `状态：${report?.ok ? 'PASS' : 'FAIL'}`,
    '````text',
    String(report?.output ?? '(未提供 verify-plugin 输出)').trim(),
    '````',
  ].join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  const pluginDir = argv.find((arg) => !arg.startsWith('--')) ?? '';
  const outIndex = argv.indexOf('--out');
  const outPath = outIndex >= 0 ? argv[outIndex + 1] : null;
  if (!pluginDir || !existsSync(resolve(ROOT, pluginDir))) {
    console.error(`verify-plugin-gate: plugin dir not found: ${pluginDir || '(missing)'}`);
    process.exit(2);
  }
  if (!existsSync(VERIFIER)) {
    console.error('verify-plugin-gate: vendored verifier missing at scripts/vendor/verify-plugin.mjs');
    process.exit(2);
  }
  const report = runVerifyPlugin({ pluginDir });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outPath) writeFileSync(resolve(outPath), json, 'utf8');
  else process.stdout.write(json);
  console.error(`verify-plugin: ${report.ok ? 'PASS' : 'FAIL'} (${report.output.split('\n').slice(-1)[0] ?? ''})`);
  if (outPath) process.stdout.write(readFileSync(resolve(outPath), 'utf8'));
  process.exit(report.ok ? 0 : 1);
}

const invoked = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : '';
if (import.meta.url === invoked) main();
