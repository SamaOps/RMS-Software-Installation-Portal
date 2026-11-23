import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatServerPayload,
  toServerInstallerType,
  toServerSilentArgs,
  RmsServerClient,
} from '../src/lib/rmsServerClient.js';

test('toServerInstallerType maps portal types to server types', () => {
  assert.equal(toServerInstallerType('InnoSetup'), 'inno');
  assert.equal(toServerInstallerType('inno'), 'inno');
  assert.equal(toServerInstallerType('MSI'), 'msi');
  assert.equal(toServerInstallerType('winget'), 'winget');
  assert.equal(toServerInstallerType('Custom'), 'custom_exe');
  assert.equal(toServerInstallerType('Portable'), 'custom_exe');
  assert.equal(toServerInstallerType('script'), 'script');
});

test('toServerSilentArgs converts string to switches array or preserves object', () => {
  const parsed = toServerSilentArgs('/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');
  assert.deepEqual(parsed.switches, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES']);
  assert.equal(parsed.args, '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES');

  const obj = { switches: ['/S', '/v"/qn"'] };
  assert.deepEqual(toServerSilentArgs(obj), obj);
});

test('formatServerPayload formats strict camelCase payload matching team specification', () => {
  const portalInput = {
    software_name: 'aitutor',
    winget_id: 'AITutor-Setup-0.1.0-3a70d13.exe',
    source_type: 'rms-repository',
    installer_type: 'InnoSetup',
    silent_args: '/VERYSILENT /NORESTART /SUPPRESSMSGBOXES',
    run_as: 'system',
    elevation: 'highest',
    timeout_seconds: 600,
    success_exit_codes: '0,3010',
    is_portable: false,
    is_global: true,
    is_active: true,
    pre_install_script: "Write-Host 'Checking dependencies...'",
    post_install_script: "Write-Host 'Setup finished successfully.'",
    custom_install_script: null,
    // Extra portal internal fields that MUST be filtered out
    replaces_software_id: '123',
    pilot_required_successes: 5,
    test_device_serials: ['ABC'],
  };

  const payload = formatServerPayload(portalInput, false);

  assert.equal(payload.softwareName, 'aitutor');
  assert.equal(payload.wingetId, 'AITutor-Setup-0.1.0-3a70d13.exe');
  assert.equal(payload.source, 'rms-repository');
  assert.equal(payload.installerType, 'inno');
  assert.deepEqual(payload.silentArgs.switches, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES']);
  assert.equal(payload.runAs, 'system');
  assert.equal(payload.elevation, 'highest');
  assert.equal(payload.timeoutSeconds, 600);
  assert.equal(payload.successExitCodes, '0,3010');
  assert.equal(payload.isPortable, false);
  assert.equal(payload.isGlobal, true);
  assert.equal(payload.isActive, true);
  assert.equal(payload.preInstallScript, "Write-Host 'Checking dependencies...'");
  assert.equal(payload.postInstallScript, "Write-Host 'Setup finished successfully.'");

  // Ensure NO unwanted extra properties exist
  assert.equal(payload.replaces_software_id, undefined);
  assert.equal(payload.replacesSoftwareId, undefined);
  assert.equal(payload.pilot_required_successes, undefined);
  assert.equal(payload.test_device_serials, undefined);
});

test('RmsServerClient generates valid HMAC authentication headers', () => {
  const client = new RmsServerClient({
    apiUrl: 'http://localhost:3000',
    apiKey: 'test-secret-key-123',
    authEnabled: true,
  });

  const headers = client.getHeaders();
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(headers['X-Timestamp'], 'X-Timestamp should be present');
  assert.ok(headers['X-API-Signature'], 'X-API-Signature should be present');
  assert.equal(typeof headers['X-API-Signature'], 'string');
  assert.equal(headers['X-API-Signature'].length, 64); // SHA-256 hex length
});
