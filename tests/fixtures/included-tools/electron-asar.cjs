const assert = require('node:assert/strict');
const { app } = require('electron');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const [archive, output, repository] = process.argv.slice(2);
app.setPath('userData', join(output, 'electron-profile'));
(async () => {
  const { createJiti } = require(join(repository, 'node_modules', 'jiti'));
  const jiti = createJiti(__filename, { moduleCache: true, fsCache: false });
  const root = join(archive, 'resources', 'included-tools');
  for (const name of ['computer', 'web', 'mcp', 'documents']) {
    const loaded = await jiti.import(join(root, name, 'index.ts'));
    assert.equal(typeof loaded.default, 'function', `${name} factory imports from ASAR`);
  }
  const { FileCredentialStore, ModelRuntime, SettingsManager } = await jiti.import('@earendil-works/pi-coding-agent');
  const { loadAgentSkillCatalog } = await jiti.import(join(repository, 'src/local/agent/skill-catalog.ts'));
  const agentDir = join(output, 'agent'), stateRoot = join(output, 'catalog-state');
  const authStorage = FileCredentialStore.inMemory(), modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
  const provider = { resolveRuntime: async () => ({ agentDir, credentials: authStorage, modelRuntime, settingsManager: SettingsManager.inMemory(), projectTrust: { override: true }, includedTools: { rootPath: root, stateRoot, helperAppPath: join(output, 'Missing Computer.app') } }) };
  for (const name of ['connected-folder-a', 'connected-folder-b']) {
    const cwd = join(output, name); await fs.mkdir(cwd, { recursive: true });
    const catalog = await loadAgentSkillCatalog(cwd, provider);
    assert.deepEqual(catalog.diagnostics.filter(item => item.type === 'error' || item.type === 'collision'), []);
    assert.equal(catalog.extensions.filter(item => item.source.source === 'Included with AmpleFile').length, 4);
  }
  await assert.rejects(fs.stat(stateRoot));
  console.log('PASS Electron ASAR: all four native factories load');
  app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
