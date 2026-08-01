'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const {
  activateWindowsTerminalTab,
  activateWindowsTerminalTabBroker,
  focusSessionTarget,
  normalizeWindowHandle,
  normalizeRuntimeId,
  hydrateWindowsTerminalTabRoute,
  requestTerminalFocusBroker,
  closeTerminalFocusBrokerChannel,
  WINDOWS_TERMINAL_HELPER,
  WINDOWS_TERMINAL_BROKER,
  WINDOWS_TERMINAL_BROKER_INSTALLER,
} = require('../backend/focus');
const {
  captureWindowsTerminalTabRoute,
  enrichWindowsTabRoute,
  hasWtTabRoute,
  normalizeWtTabRuntimeId,
  readCachedWindowsTerminalTabRoute,
  windowsProcessExists,
  WT_TAB_CAPTURE_HELPER,
} = require('../backend/pidwalk');

const WT_SESSION = '977e6134-10f1-4487-b153-e6845b21716f';
const SESSION = {
  id: '22222222-2222-4222-8222-222222222222',
  agentId: 'codex',
  state: 'idle',
  wtSession: WT_SESSION,
  wtHwnd: '123456',
  wtTabRuntimeId: [42, -7, 9001],
};

async function main() {
  assert.strictEqual(normalizeWindowHandle('123456'), '123456');
  assert.strictEqual(normalizeWindowHandle('0'), null);
  assert.deepStrictEqual(normalizeRuntimeId([42, -7, 9001]), [42, -7, 9001]);
  assert.strictEqual(normalizeRuntimeId([]), null);
  assert.deepStrictEqual(normalizeWtTabRuntimeId([1, -2, 3]), [1, -2, 3]);
  assert(hasWtTabRoute(SESSION));

  const cachedRoute = readCachedWindowsTerminalTabRoute(SESSION.id, {
    readCache: (sessionId) => {
      assert.strictEqual(sessionId, SESSION.id);
      return SESSION;
    },
  });
  assert.deepStrictEqual(cachedRoute, {
    wtSession: WT_SESSION,
    wtHwnd: '123456',
    wtTabRuntimeId: [42, -7, 9001],
  });
  assert.strictEqual(windowsProcessExists(123, { kill: () => {} }), true);
  assert.strictEqual(windowsProcessExists(123, {
    kill: () => { const error = new Error('denied'); error.code = 'EPERM'; throw error; },
  }), true, 'Windows Terminal EPERM means the process exists but cannot be signalled');
  assert.strictEqual(windowsProcessExists(123, {
    kill: () => { const error = new Error('gone'); error.code = 'ESRCH'; throw error; },
  }), false);

  let exactCalls = 0;
  let result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async (target) => {
      exactCalls++;
      assert.strictEqual(target, SESSION);
      return { ok: true };
    },
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' });
  assert.strictEqual(exactCalls, 1);

  result = await focusSessionTarget({ ...SESSION, state: 'sleeping' }, {
    platform: 'win32',
    exactFocus: async () => ({ ok: true }),
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' },
    'an inactive but still-open tab must remain focusable');

  result = await focusSessionTarget({ ...SESSION, wtTabRuntimeId: null }, {
    platform: 'win32',
    readCachedRoute: () => null,
    exactFocus: async () => { throw new Error('missing routes must not invoke the helper'); },
    legacyFocus: async () => { throw new Error('Windows must not focus a possibly wrong window'); },
  });
  assert.deepStrictEqual(result, { ok: false, route: 'failed', reason: 'route-missing' });

  const memoryStale = { ...SESSION, wtHwnd: null, wtTabRuntimeId: null };
  let hydratedTarget = null;
  result = await focusSessionTarget(memoryStale, {
    platform: 'win32',
    readCachedRoute: (sessionId) => {
      assert.strictEqual(sessionId, SESSION.id);
      return {
        wtSession: WT_SESSION,
        wtHwnd: '654321',
        wtTabRuntimeId: [42, 8, 10],
      };
    },
    exactFocus: async (target) => {
      hydratedTarget = target;
      return { ok: true };
    },
  });
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab' });
  assert.strictEqual(hydratedTarget.wtHwnd, '654321');
  assert.deepStrictEqual(hydratedTarget.wtTabRuntimeId, [42, 8, 10]);
  assert.strictEqual(memoryStale.wtHwnd, null, 'focus hydration must not mutate the core session');

  const mismatchedRoute = hydrateWindowsTerminalTabRoute(memoryStale, {
    readCachedRoute: () => ({
      wtSession: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      wtHwnd: '654321',
      wtTabRuntimeId: [42, 8, 10],
    }),
  });
  assert.strictEqual(mismatchedRoute, memoryStale,
    'a cache entry for a different WT_SESSION must never be focused');

  result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async () => ({ ok: false, reason: 'tab-closed' }),
    legacyFocus: async () => { throw new Error('failure must not use window-level fallback'); },
  });
  assert.deepStrictEqual(result, { ok: false, route: 'failed', reason: 'tab-closed' });

  let brokerTarget = null;
  result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async () => ({ ok: false, reason: 'elevation-required' }),
    brokerFocus: async (target) => {
      brokerTarget = target;
      return { ok: true };
    },
  });
  assert.strictEqual(brokerTarget, SESSION);
  assert.deepStrictEqual(result, { ok: true, route: 'windows-terminal-tab-broker' });

  result = await focusSessionTarget(SESSION, {
    platform: 'win32',
    exactFocus: async () => ({ ok: false, reason: 'elevation-required' }),
    brokerFocus: async () => ({ ok: false, reason: 'broker-unavailable' }),
  });
  assert.deepStrictEqual(result, { ok: false, route: 'failed', reason: 'broker-unavailable' });

  result = await focusSessionTarget(SESSION, {
    platform: 'darwin',
    legacyFocus: async () => true,
  });
  assert.deepStrictEqual(result, { ok: true, route: 'terminal-window' },
    'non-Windows focus behavior must remain compatible');

  let focusArgs = null;
  result = await activateWindowsTerminalTab(SESSION, {
    execFile: (_bin, args, _options, callback) => {
      focusArgs = args;
      callback(null, '{"ok":true,"reason":"focused"}\n', '');
    },
  });
  assert.deepStrictEqual(result, { ok: true });
  assert(focusArgs.includes('-WindowHandle') && focusArgs.includes('123456'));
  assert(focusArgs.includes('-RuntimeId') && focusArgs.includes('42,-7,9001'));
  assert(!focusArgs.includes('-PidList') && !focusArgs.includes('-Marker'));

  let brokerPayload = null;
  result = await activateWindowsTerminalTabBroker(SESSION, {
    request: async (payload) => {
      brokerPayload = payload;
      return { ok: true };
    },
  });
  assert.deepStrictEqual(result, { ok: true });
  assert.deepStrictEqual(brokerPayload, {
    protocol: 1,
    operation: 'focus-windows-terminal-tab',
    windowHandle: '123456',
    runtimeId: [42, -7, 9001],
  });

  let captureOptions = null;
  const captured = captureWindowsTerminalTabRoute({
    execFileSync: (_bin, args, options) => {
      captureOptions = { args, options };
      return '{"ok":true,"reason":"captured","hwnd":"123456","runtimeId":[42,-7,9001]}\n';
    },
  });
  assert.deepStrictEqual(captured, { wtHwnd: '123456', wtTabRuntimeId: [42, -7, 9001] });
  assert(captureOptions.args.includes('-File') && captureOptions.args.includes(WT_TAB_CAPTURE_HELPER));
  assert(!captureOptions.args.includes('-Marker'));
  assert.strictEqual(captureOptions.options.windowsHide, true,
    'foreground UI Automation capture must not flash a PowerShell window');

  let captures = 0;
  const existing = enrichWindowsTabRoute(SESSION, {
    wtSession: WT_SESSION,
    capture: () => { captures++; return null; },
    now: 100000,
  });
  assert.strictEqual(existing.changed, false);
  assert.strictEqual(captures, 0, 'a cached exact route should be reused within the turn');

  const missing = enrichWindowsTabRoute({ wtTabCaptureAttemptedAt: 1 }, {
    wtSession: WT_SESSION,
    capture: () => { captures++; return null; },
    now: 999999,
  });
  assert.strictEqual(missing.changed, false);
  assert.strictEqual(captures, 0,
    'tool hooks must never capture whichever Terminal tab happens to be foreground');

  const refreshed = enrichWindowsTabRoute(SESSION, {
    wtSession: WT_SESSION,
    refresh: true,
    capture: () => {
      captures++;
      return { wtHwnd: '654321', wtTabRuntimeId: [99, 1] };
    },
    now: 200000,
  });
  assert.strictEqual(refreshed.changed, true);
  assert.strictEqual(captures, 1);
  assert.strictEqual(refreshed.result.wtHwnd, '654321');
  assert.deepStrictEqual(refreshed.result.wtTabRuntimeId, [99, 1]);

  const captureSource = fs.readFileSync(WT_TAB_CAPTURE_HELPER, 'utf8');
  const focusSource = fs.readFileSync(WINDOWS_TERMINAL_HELPER, 'utf8');
  const brokerSource = fs.readFileSync(WINDOWS_TERMINAL_BROKER, 'utf8');
  const brokerInstallerSource = fs.readFileSync(WINDOWS_TERMINAL_BROKER_INSTALLER, 'utf8');
  assert(captureSource.includes('GetForegroundWindow'));
  assert(captureSource.includes('SelectionItemPattern'));
  assert(captureSource.includes('IsSelected'));
  assert(captureSource.includes('GetRuntimeId()'));
  assert(!captureSource.includes('SetConsoleTitle') && !captureSource.includes('AttachConsole'),
    'capture must not depend on a hook console or mutate the tab title');
  assert(focusSource.includes('SelectionItemPattern'));
  assert(focusSource.includes('Test-RuntimeIdEqual'));
  assert(focusSource.includes('GetProcessIntegrityRid'));
  assert(focusSource.includes('elevation-required'));
  assert(!focusSource.includes('AttachConsole') && !focusSource.includes('SetConsoleTitle'),
    'click-time focus must not attach to or rename a console');
  assert(brokerSource.includes('GetNamedPipeServerProcessId') && brokerSource.includes('$InstalledAppPath'));
  assert(brokerSource.includes('Test-BrokerClient') && brokerSource.includes('Test-WindowsTerminalWindow'));
  assert(brokerSource.includes("'..\\..\\..\\LLMPET.exe'"));
  assert(brokerSource.includes("'focus-windows-terminal-tab'") && brokerSource.includes('operation-denied'));
  assert(!/Invoke-Expression|Start-Process|wt\.exe|new-tab|resume/i.test(brokerSource),
    'the elevated broker must not accept or launch arbitrary commands or terminals');
  assert(brokerInstallerSource.includes('New-ScheduledTaskPrincipal'));
  assert(brokerInstallerSource.includes('-RunLevel Highest'));
  assert(brokerInstallerSource.includes('-LogonType Interactive'));
  assert(!brokerInstallerSource.includes('ExpectedClientPath') && !brokerInstallerSource.includes('-PipeName'));

  if (process.platform === 'win32') {
    const testPipePath = `\\\\.\\pipe\\LLMPET.TerminalFocus.Test.${process.pid}.${Date.now()}`;
    const brokerRequest = requestTerminalFocusBroker(brokerPayload, {
      pipePath: testPipePath,
      timeoutMs: 1000,
    });
    const fakeBroker = await new Promise((resolve, reject) => {
      const deadline = Date.now() + 1000;
      const connect = () => {
        const socket = net.createConnection(testPipePath, () => resolve(socket));
        socket.once('error', (error) => {
          socket.destroy();
          if (Date.now() < deadline) setTimeout(connect, 20);
          else reject(error);
        });
      };
      connect();
    });
    await new Promise((resolve, reject) => {
      let request = '';
      fakeBroker.setEncoding('utf8');
      fakeBroker.once('error', reject);
      fakeBroker.on('data', (chunk) => {
        request += chunk;
        if (!/\r?\n/.test(request)) return;
        const payload = JSON.parse(request.trim());
        assert.strictEqual(payload.operation, 'focus-windows-terminal-tab');
        fakeBroker.write('{"ok":true,"reason":"focused"}\n', resolve);
      });
    });
    try {
      const brokerResult = await brokerRequest;
      assert.deepStrictEqual(brokerResult, { ok: true });
    } finally {
      fakeBroker.destroy();
      closeTerminalFocusBrokerChannel(testPipePath);
    }

    const captureParsed = childProcess.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WT_TAB_CAPTURE_HELPER, '-TimeoutMs', '250',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert([0, 1].includes(captureParsed.status), captureParsed.stderr);
    assert.strictEqual(typeof JSON.parse(captureParsed.stdout.trim()).reason, 'string');

    const focusParsed = childProcess.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_TERMINAL_HELPER, '-WindowHandle', 'invalid', '-RuntimeId', 'invalid',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.strictEqual(focusParsed.status, 2, focusParsed.stderr);
    assert.strictEqual(JSON.parse(focusParsed.stdout.trim()).reason, 'invalid-arguments');

    const brokerParsed = childProcess.spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_TERMINAL_BROKER, '-SelfTest',
    ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
    assert.strictEqual(brokerParsed.status, 0, brokerParsed.stderr);
    assert.strictEqual(JSON.parse(brokerParsed.stdout.trim()).reason, 'self-test-passed');

    const reconnectPipeName = `LLMPET.TerminalFocus.Reconnect.${process.pid}.${Date.now()}`;
    const reconnectPipePath = `\\\\.\\pipe\\${reconnectPipeName}`;
    const brokerProcess = childProcess.spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', WINDOWS_TERMINAL_BROKER,
      '-ExpectedClientPath', process.execPath,
      '-PipeName', reconnectPipeName,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        const health = await requestTerminalFocusBroker({ protocol: 1, operation: 'health' }, {
          pipePath: reconnectPipePath,
          timeoutMs: 3000,
        });
        assert.deepStrictEqual(health, { ok: true });
        closeTerminalFocusBrokerChannel(reconnectPipePath);
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(brokerProcess.exitCode, null,
          'the broker must survive a desktop pet process disconnect and reconnect');
      }
    } finally {
      brokerProcess.kill();
    }
  }

  const backendFocusSource = fs.readFileSync(path.join(__dirname, '..', 'backend', 'focus.js'), 'utf8');
  const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert(!/resumeSession|resumed-tab|launchCliInRecentWindowsTerminal|wt\.exe/.test(backendFocusSource),
    'session click path must never resume a CLI or launch Windows Terminal');
  assert(!/Start-Process[\s\S]*-Verb\s+RunAs/i.test(backendFocusSource),
    'session clicks must never trigger a per-click UAC prompt');
  assert(preloadSource.includes("ipcRenderer.invoke('focus-session'"));
  assert(mainSource.includes("ipcMain.handle('focus-session'"));
  assert(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'pet.js'), 'utf8')
    .includes('sess.focusBrokerUnavailable'));

  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const installerSource = fs.readFileSync(path.join(__dirname, '..', 'assets', 'installer.nsh'), 'utf8');
  assert.strictEqual(packageJson.build.nsis.perMachine, true,
    'the installer must receive one-time elevation to register the broker safely');
  assert.strictEqual(packageJson.build.nsis.include, 'assets/installer.nsh');
  assert(installerSource.includes('customInstall') && installerSource.includes('customUnInstall'));

  console.log('session focus checks passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
