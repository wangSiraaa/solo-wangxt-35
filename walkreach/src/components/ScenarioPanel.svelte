<script lang="ts">
  import { scenarios } from '../lib/stores';
  import {
    exportScenarioJson,
    importScenarioJson,
    loadScenarioById,
    removeScenario,
    saveCurrentScenario
  } from '../lib/controller';

  let name = '';

  async function save() {
    await saveCurrentScenario(name.trim());
    name = '';
  }

  function fmt(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  }

  async function onImport(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) await importScenarioJson(file);
  }
</script>

<section class="panel">
  <h2>场景（IndexedDB）</h2>
  <div class="save-row">
    <input placeholder="场景名称" bind:value={name} />
    <button class="primary" on:click={save}>保存</button>
  </div>
  <div class="save-row io">
    <button on:click={() => exportScenarioJson()}>导出 JSON（含时区与日历）</button>
    <label class="import-label">导入 JSON<input type="file" accept=".json" on:change={onImport} /></label>
  </div>
  {#if $scenarios.length === 0}
    <p class="hint">暂无已保存场景。</p>
  {/if}
  <ul class="list">
    {#each $scenarios as s}
      <li>
        <div class="meta">
          <b>{s.name}</b>
          <small>{fmt(s.savedAt)}</small>
        </div>
        <div class="ops">
          <button on:click={() => loadScenarioById(s.id)}>加载</button>
          <button on:click={() => removeScenario(s.id)}>删除</button>
        </div>
      </li>
    {/each}
  </ul>
</section>

<style>
  .panel {
    padding: 10px 12px;
    border-bottom: 1px solid #dde3da;
  }
  h2 {
    font-size: 13px;
    margin: 0 0 8px;
    color: #3c4a3a;
    letter-spacing: 0.05em;
  }
  .save-row {
    display: flex;
    gap: 6px;
  }
  .save-row.io {
    margin-top: 6px;
  }
  .save-row input {
    flex: 1;
    font: inherit;
    font-size: 13px;
    padding: 4px 6px;
    border: 1px solid #b9c4b4;
    border-radius: 4px;
  }
  button {
    font: inherit;
    font-size: 12px;
    padding: 4px 10px;
    border: 1px solid #b9c4b4;
    background: #f6f8f4;
    border-radius: 4px;
    cursor: pointer;
  }
  button.primary {
    background: #2f6f4f;
    border-color: #2f6f4f;
    color: #fff;
  }
  .import-label {
    font-size: 12px;
    padding: 4px 10px;
    border: 1px solid #b9c4b4;
    background: #f6f8f4;
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .import-label input {
    display: none;
  }
  .list {
    list-style: none;
    margin: 8px 0 0;
    padding: 0;
  }
  .list li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 5px 0;
    border-top: 1px solid #edf1ea;
    font-size: 12px;
  }
  .meta {
    display: flex;
    flex-direction: column;
  }
  .meta small {
    color: #8a9a86;
  }
  .ops {
    display: flex;
    gap: 4px;
  }
  .hint {
    font-size: 12px;
    color: #5a6a58;
  }
</style>
