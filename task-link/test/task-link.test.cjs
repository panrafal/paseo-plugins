const assert = require('node:assert/strict');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Paseo supplies these modules at runtime. Load source with the same boundary,
// using the real Zod/React packages and a small fake client for lifecycle tests.
function loadSource(entry, { modules = {}, globals = {} } = {}) {
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    }).outputText;
    const localRequire = (name) => {
      if (name in modules) return modules[name];
      if (name === '@getpaseo/plugin') return { defineRpc: (definition) => definition };
      if (name === '@getpaseo/plugin/client') return {};
      if (name === '@getpaseo/plugin/client/ui' || name === '@getpaseo/plugin/client/react-native')
        return {};
      if (!name.startsWith('.')) return require(name);
      const target = path.resolve(path.dirname(filename), name);
      return load([`${target}.ts`, `${target}.tsx`].find((file) => require('node:fs').existsSync(file)));
    };
    vm.runInNewContext(code, {
      module, exports: module.exports, require: localRequire,
      process, console, URL, setInterval, clearInterval, ...globals,
    }, { filename });
    return module.exports;
  }
  return load(path.resolve(__dirname, '..', entry));
}

const { findTask, findTaskIn, taskUrl, DEFAULT_TASK_LINK_SETTINGS } = loadSource('shared/link.ts');
const { TaskLinkSettingsSchema } = loadSource('shared/settings.ts');

test('extracts the first non-empty capture, including alternative subexpressions', () => {
  const alternatives = String.raw`(\[CT-\d+\])|-(ct-\d+)`;
  assert.equal(findTask('feature/CT-1234-fix', String.raw`\b(CT-\d+)\b`), 'CT-1234');
  assert.equal(findTask('Fix [CT-1234]', alternatives), '[CT-1234]');
  assert.equal(findTask('feature-ct-42', alternatives), 'ct-42');
  assert.equal(findTask('feature-ct-42 [CT-1234]', alternatives), 'ct-42');
  assert.equal(findTask('CT-1234', String.raw`CT-(\d+)`), '1234');
  assert.equal(findTask('CT-1234', String.raw`()((CT)-(\d+))`), 'CT-1234');
  assert.equal(findTask('prefix CT-42', String.raw`(CT-\d+)|()`), 'CT-42');
  assert.equal(findTask('prefix CT-42', String.raw`prefix|(CT-\d+)`), 'CT-42');
  assert.equal(findTask('text', '()'), null);
  assert.equal(findTask(null, '(CT)'), null);
  assert.equal(findTask('CT-42', String.raw`CT-\d+`), 'CT-42');
  assert.equal(findTask('ct-42', String.raw`CT-\d+`), null);
  assert.equal(findTask('ct-42', DEFAULT_TASK_LINK_SETTINGS.pattern), 'ct-42');
});

test('keeps source priority and escapes every ID substitution', () => {
  const pattern = String.raw`\b(CT-\d+)\b`;
  assert.equal(findTaskIn(pattern, 'branch/CT-1', 'title CT-2', 'workspace CT-3'), 'CT-1');
  assert.equal(findTaskIn(pattern, undefined, 'title CT-2', 'workspace CT-3'), 'CT-2');
  assert.equal(taskUrl('[CT-42]', 'https://example.com/{ID}?task={ID}'), 'https://example.com/%5BCT-42%5D?task=%5BCT-42%5D');
  assert.equal(taskUrl('a/b ?#&$&', 'https://example.com/{ID}'), 'https://example.com/a%2Fb%20%3F%23%26%24%26');
});

test('validates regex and HTTP(S) templates before saving', () => {
  assert.equal(TaskLinkSettingsSchema.safeParse(DEFAULT_TASK_LINK_SETTINGS).success, true);
  for (const pattern of ['', '(', '[', 'a{2,1}']) {
    assert.equal(TaskLinkSettingsSchema.safeParse({ ...DEFAULT_TASK_LINK_SETTINGS, pattern }).success, false);
  }
  for (const urlTemplate of ['https://example.com/no-placeholder', 'javascript:{ID}', 'file:///{ID}', 'not a url {ID}']) {
    assert.equal(TaskLinkSettingsSchema.safeParse({ ...DEFAULT_TASK_LINK_SETTINGS, urlTemplate }).success, false);
  }
});

test('persists validated settings atomically and keeps invalid existing data', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'task-link-settings-'));
  try {
    const { readTaskLinkSettings, writeTaskLinkSettings } = loadSource('server/settings.ts', {
      globals: { process: { env: { PASEO_HOME: directory } } },
    });
    assert.equal((await readTaskLinkSettings()).urlTemplate, DEFAULT_TASK_LINK_SETTINGS.urlTemplate);
    const settings = { pattern: '(TASK-123)', urlTemplate: 'https://example.com/{ID}' };
    await writeTaskLinkSettings(settings);
    assert.equal((await readTaskLinkSettings()).pattern, settings.pattern);
    const file = path.join(directory, 'plugin-data/task-link/settings.json');
    const saved = await readFile(file, 'utf8');
    await assert.rejects(writeTaskLinkSettings({ ...settings, pattern: '(' }));
    assert.equal(await readFile(file, 'utf8'), saved);
    await writeFile(file, '{bad json');
    await assert.rejects(readTaskLinkSettings());
    assert.equal(await readFile(file, 'utf8'), '{bad json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const settle = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

test('updates pills on settings changes, opens current links, and removes registrations on teardown', async () => {
  let savedSettings = { ...DEFAULT_TASK_LINK_SETTINGS };
  let onAgent, onWorkspace, screen, command, poll;
  let cleared = false;
  let removedSubscriptions = 0;
  let removedScreens = 0;
  const pills = new Map();
  const opened = [];
  const agent = { id: 'a1', workspaceId: 'w1', cwd: '/project', title: 'Fix CT-2', status: 'idle' };
  const { contributeClient } = loadSource('client/pill.tsx', {
    modules: { 'react-native': { Platform: { OS: 'ios' }, Text: 'Text', Linking: { openURL: async (url) => opened.push(url) } } },
    globals: { setInterval: (callback) => { poll = callback; return 1; }, clearInterval: () => { cleared = true; } },
  });
  const client = {
    paseo: {
      agents: {
        subscribe: (callback) => { onAgent = callback; return () => { removedSubscriptions++; }; },
        list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false } }),
      },
      workspaces: {
        subscribe: (callback) => { onWorkspace = callback; return () => { removedSubscriptions++; }; },
        list: async () => ({ entries: [{ id: 'w1', name: 'workspace CT-3' }] }),
      },
    },
    rpc: async (contract) => contract.name === 'task-link.branch' ? { branch: 'feature/CT-1' } : savedSettings,
    addComposerPill: (pill) => { pills.set(pill.agentId, pill); return () => pills.delete(pill.agentId); },
    addSettingsScreen: (value) => { screen = value; return () => { removedScreens++; }; },
    addCommandCenterItem: (value) => { command = value; return () => { removedScreens++; }; },
  };
  const cleanup = contributeClient(client);
  await settle();
  assert.equal(pills.size, 1);
  assert.equal(pills.get('a1').title, 'Open task CT-1');
  let openedScreen;
  command.onSelect({ openSettings: (id) => { openedScreen = id; } });
  assert.equal(openedScreen, screen.id);
  const applySettings = screen.Component({}).props.onSaved;
  savedSettings = { ...savedSettings, urlTemplate: 'https://example.com/{ID}' };
  applySettings(savedSettings);
  await pills.get('a1').onPress();
  assert.equal(opened.pop(), 'https://example.com/CT-1');
  savedSettings = { pattern: '(CT-2)', urlTemplate: 'https://other.example/{ID}' };
  await pills.get('a1').onPress();
  assert.equal(opened.pop(), 'https://other.example/CT-2');
  assert.equal(pills.get('a1').title, 'Open task CT-2');
  savedSettings = { ...savedSettings, pattern: '(OTHER-\\d+)' };
  poll();
  await settle();
  assert.equal(pills.size, 0);
  onAgent({ kind: 'upsert', agent: { ...agent, title: 'OTHER-5' } });
  assert.equal(pills.get('a1').title, 'Open task OTHER-5');
  onAgent({ kind: 'upsert', agent: { ...agent, title: 'OTHER-5', archivedAt: 'now' } });
  assert.equal(pills.size, 0);
  onAgent({ kind: 'upsert', agent: { ...agent, title: 'OTHER-6' } });
  assert.equal(pills.size, 1);
  const originalRpc = client.rpc;
  let finishStaleRead;
  client.rpc = () => new Promise((resolve) => { finishStaleRead = resolve; });
  poll();
  applySettings({ ...savedSettings, pattern: '(NEVER-MATCH)' });
  finishStaleRead(savedSettings);
  await settle();
  assert.equal(pills.size, 0, 'an older read cannot undo a local save');
  client.rpc = originalRpc;
  applySettings(savedSettings);
  assert.equal(pills.size, 1);
  poll();
  cleanup();
  await settle();
  assert.equal(pills.size, 0);
  assert.equal(cleared, true);
  assert.equal(removedSubscriptions, 2);
  assert.equal(removedScreens, 2);
});
