import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { loadProposedContractReference, projectRoot, referenceRoot } from './proposed-contract-reference.mjs';

async function main() {
  const javascript = await loadProposedContractReference();
  const localPython = path.join(projectRoot, 'artifacts/contracts-validation-deps');
  const env = { ...process.env, PYTHONPATH: [localPython, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter) };
  const wrapper = path.join(projectRoot, 'scripts/validate-proposed-contracts.py');
  let python;
  for (const [command, prefix] of [['py', ['-3.11']], ['python', []], ['python3', []]]) {
    const run = spawnSync(command, [...prefix, '-X', 'utf8', wrapper, referenceRoot], { cwd: projectRoot, env, encoding: 'utf8', input: JSON.stringify({ additional_cases: javascript.additionalCases }), timeout: 60_000, maxBuffer: 4_000_000, windowsHide: true });
    if (run.error?.code === 'ENOENT' || run.status !== 0 && /No module named 'jsonschema'|No suitable Python runtime/.test(run.stderr ?? '')) continue;
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`Python reference validation failed: ${run.stdout}\n${run.stderr}`);
    python = JSON.parse(run.stdout); break;
  }
  if (!python) throw new Error('Python jsonschema is required. Install packages/contracts/requirements-validation.txt into your Python environment, or: py -3.11 -m pip install --target artifacts/contracts-validation-deps -r packages/contracts/requirements-validation.txt');
  if (python.validator_version !== '4.26.0' || python.schema_count !== 5) throw new Error('Unexpected Python validator version/schema count');
  for (const group of ['shapes', 'sources', 'additional']) {
    if (JSON.stringify(javascript[group]) !== JSON.stringify(python[group])) throw new Error(`JavaScript/Python parity failed: ${group}`);
    if (!javascript[group].every(row => row.passed)) throw new Error(`Reference cases failed: ${group}`);
  }
  const compatibility = JSON.parse(await readFile(path.join(projectRoot, 'packages/contracts/policy-compatibility.json'), 'utf8'));
  const report = {
    status: 'passed', scope: 'versioned_reference_validation_only', runtime_integrated: false,
    archive_sha256: javascript.metadata.archive_sha256,
    schema_count: 5, shape_cases: 52, shape_passed: 52, source_span_cases: 4, source_span_passed: 4,
    extra_parity_cases: javascript.additional.length,
    javascript: { validator: 'ajv', version: javascript.validatorVersion, dialect: 'fail_closed_shared_subset_projected_to_draft7' },
    python: { validator: python.validator, version: python.validator_version, dialect: python.dialect },
    application_e2e: 'not_run_by_this_command', paid_api_calls: 0,
    policy_compatibility: compatibility.status, compatibility_findings: compatibility.findings,
    cases: { shapes: javascript.shapes, source_spans: javascript.sources, additional_parity: javascript.additional },
  };
  const output = path.join(projectRoot, 'artifacts/proposed-contracts-validation.json');
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ ...report, cases: undefined, compatibility_findings: undefined, report: output }, null, 2) + '\n');
}
main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
