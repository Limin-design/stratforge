class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

(globalThis as { localStorage?: MemoryStorage }).localStorage = new MemoryStorage();

const chats = await import("../src/chats.ts");
const store = await import("../src/store.ts");
const agentConfig = await import("../src/agent/config.ts");
const vault = await import("../src/agent/vault.ts");

const SYSTEM = [{ role: "system", content: "test" }] as const;

const chatA = chats.newChat();
chats.saveChat(chatA.id, [{ role: "user", text: "alpha" }], [...SYSTEM, { role: "user", content: "alpha" }]);

const chatB = chats.newChat();
chats.saveActive([{ role: "user", text: "beta" }], [...SYSTEM, { role: "user", content: "beta" }]);

chats.saveChat(chatA.id, [{ role: "user", text: "alpha-updated" }], [...SYSTEM, { role: "user", content: "alpha-updated" }]);
assert(chats.getActiveId() === chatB.id, "saveChat must not change active chat");

const latest = chats.listChats();
const afterA = latest.find((c) => c.id === chatA.id);
const afterB = latest.find((c) => c.id === chatB.id);
assert(afterA?.display.at(-1)?.text === "alpha-updated", "targeted chat payload should update");
assert(afterB?.display.at(-1)?.text === "beta", "non-targeted chat payload should stay intact");

store.setState({ datasetName: "dataset-a" }, chatA.id);
store.setState({ datasetName: "dataset-b" }, chatB.id);
assert(store.getState(chatA.id).datasetName === "dataset-a", "workspace A state should stay isolated");
assert(store.getState(chatB.id).datasetName === "dataset-b", "workspace B state should stay isolated");

store.setActiveWorkspace(chatA.id);
assert(store.getActiveWorkspaceId() === chatA.id, "active workspace should switch to chat A");
assert(store.getState().datasetName === "dataset-a", "active workspace view should read the selected workspace");

let agentCfgEvents = 0;
const offCfg = agentConfig.subscribeAgentConfig(() => {
  agentCfgEvents += 1;
});
agentConfig.setAgentConfig(chatA.id, { baseUrl: "https://openrouter.ai/api/v1", model: "model-a" });
agentConfig.setAgentConfig(chatB.id, { baseUrl: "https://api.openai.com/v1", model: "model-b" });
assert(agentConfig.getAgentConfig(chatA.id).model === "model-a", "workspace A agent config should stay isolated");
assert(agentConfig.getAgentConfig(chatB.id).model === "model-b", "workspace B agent config should stay isolated");
assert(agentCfgEvents >= 2, "agent config subscribers should receive updates");
offCfg();

let vaultEvents = 0;
const offVault = vault.subscribeVault(() => {
  vaultEvents += 1;
});

vault.saveVaultBlob("blob-a", chatA.id);
vault.saveVaultBlob("blob-b", chatB.id);
assert(vault.loadVaultBlob(chatA.id) === "blob-a", "workspace A vault blob should stay isolated");
assert(vault.loadVaultBlob(chatB.id) === "blob-b", "workspace B vault blob should stay isolated");

vault.clearVault(chatA.id);
assert(vault.loadVaultBlob(chatA.id) === null, "workspace A vault clear should not affect workspace B");
assert(vault.loadVaultBlob(chatB.id) === "blob-b", "workspace B vault blob should remain after workspace A clear");
assert(vaultEvents >= 3, "vault subscribers should receive save/clear updates");
offVault();

console.log("workspace isolation smoke passed");
