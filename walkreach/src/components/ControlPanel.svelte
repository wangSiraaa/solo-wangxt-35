<script lang="ts">
  import {
    calendar,
    clickMode,
    context,
    graphStats,
    origin,
    pendingSnap,
    settings,
    snapPurpose,
    solveMs,
    solving,
    statusMessage,
    tdEdgeCount,
    tdErrors,
    via,
    viaInfo
  } from '../lib/stores';
  import {
    cancelSnap,
    chooseSnap,
    clearVia,
    importBoundary,
    importFacilities,
    importRoads,
    importWater,
    loadDemo,
    readGeoJSONFile
  } from '../lib/controller';
  import { fmtClock } from '../lib/td';
  import type { FacilitiesFC, RoadsFC } from '../lib/types';
  import type { FeatureCollection } from 'geojson';

  let chosenEdge = '';

  $: if ($pendingSnap) {
    chosenEdge = $pendingSnap.best?.edgeId ?? $pendingSnap.candidates[0]?.edgeId ?? '';
  }

  async function onFile(e: Event, kind: 'roads' | 'facilities' | 'water' | 'boundary') {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const fc = await readGeoJSONFile<FeatureCollection>(file);
      if (fc?.type !== 'FeatureCollection') throw new Error('需要 FeatureCollection');
      if (kind === 'roads') await importRoads(fc as RoadsFC);
      else if (kind === 'facilities') await importFacilities(fc as FacilitiesFC);
      else if (kind === 'water') await importWater(fc);
      else await importBoundary(fc);
      statusMessage.set(`已导入 ${file.name}`);
    } catch (err) {
      statusMessage.set(`导入失败：${err instanceof Error ? err.message : err}`);
    }
  }

  function shortNode(id: string): string {
    const [a, b] = id.split(',');
    if (a === undefined || b === undefined) return id;
    return `${Number(a).toFixed(4)},${Number(b).toFixed(4)}`;
  }

  function nodeInfo(c: { nodes: { id: string; distM: number }[] }, i: number): string {
    const n = c.nodes[i];
    return n ? `${shortNode(n.id)}（${n.distM.toFixed(0)} m）` : '—';
  }

  function startPick(purpose: 'origin' | 'via') {
    snapPurpose.set(purpose);
    clickMode.set(purpose);
  }
</script>

<section class="panel">
  <h2>数据</h2>
  <button class="primary" on:click={() => loadDemo()}>加载演示数据（本地生成，无需密钥）</button>
  <div class="file-grid">
    <label>导入路网 GeoJSON<input type="file" accept=".geojson,.json" on:change={(e) => onFile(e, 'roads')} /></label>
    <label>导入设施点 GeoJSON<input type="file" accept=".geojson,.json" on:change={(e) => onFile(e, 'facilities')} /></label>
    <label>导入水体（可选）<input type="file" accept=".geojson,.json" on:change={(e) => onFile(e, 'water')} /></label>
    <label>导入数据边界（可选）<input type="file" accept=".geojson,.json" on:change={(e) => onFile(e, 'boundary')} /></label>
  </div>
  {#if $context.boundaryApprox}
    <p class="warn">未提供数据边界，当前按路网包围盒近似，范围外的判定仅供参考。</p>
  {/if}
</section>

{#if $graphStats}
  <section class="panel">
    <h2>路网图</h2>
    <ul class="stats">
      <li>节点 {$graphStats.nodes} · 路段 {$graphStats.edges}（有向 {$graphStats.directedEdges}）</li>
      <li>连通分量 {$graphStats.components} 个{#if $graphStats.isolatedEdges.length}，<span class="hl">{$graphStats.isolatedEdges.length} 段与主网断开</span>{/if}</li>
      {#if $graphStats.onewayEdges}<li>单行路段 {$graphStats.onewayEdges} 条（橙色）</li>{/if}
      {#if $graphStats.stairsEdges}<li>台阶 {$graphStats.stairsEdges} 段，已按禁行处理（红色虚线）</li>{/if}
      {#if $tdEdgeCount}<li>限时路段 {$tdEdgeCount} 条（定时开放 / 时段封闭）</li>{/if}
    </ul>
    {#if $tdErrors.length > 0}
      <div class="errors">
        <b>时刻数据未通过 FIFO 校验，时刻模式已禁用：</b>
        <ul>
          {#each $tdErrors as err}
            <li>{err}</li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>
{/if}

<section class="panel">
  <h2>步行参数</h2>
  <label class="row">
    步速 <b>{$settings.speedKmh.toFixed(1)}</b> km/h
    <input type="range" min="3" max="6" step="0.1" bind:value={$settings.speedKmh} />
  </label>
  <label class="row">
    时间上限 <b>{$settings.maxMinutes}</b> 分钟
    <input type="range" min="5" max="30" step="1" bind:value={$settings.maxMinutes} />
  </label>
</section>

<section class="panel">
  <h2>上学时段（时刻模式）</h2>
  <label class="row check">
    <input type="checkbox" bind:checked={$settings.timeMode} />
    启用出发时刻相关的等待与通行（FIFO 限时路段）
  </label>
  {#if $settings.timeMode}
    {#if $tdErrors.length > 0}
      <p class="warn">时刻数据未通过校验，已拒绝求解（不会退回普通最短路）。</p>
    {/if}
    <label class="row">
      出发时刻 <b>{fmtClock($settings.departureMin)}</b>
      <input type="range" min="390" max="570" step="1" bind:value={$settings.departureMin} />
    </label>
    <p class="hint">
      场景日历：{$calendar.date}（{$calendar.timezone}）。拖动出发时刻滑块会重新求解，过期结果会被丢弃。
    </p>
    <div class="via-box">
      {#if $via}
        <p class="hint">必经接送点已设置（紫色），停留
          <input class="dwell" type="number" min="0" max="30" step="1" bind:value={$settings.viaDwellMin} /> 分钟。
        </p>
        {#if $viaInfo}
          <p class="hint">
            第一段 {fmtClock($viaInfo.arrivalMin)} 到达接送点，停留后 {fmtClock($viaInfo.departMin)} 出发第二段。
          </p>
        {/if}
        <div class="btn-row">
          <button on:click={() => startPick('via')}>重新设置</button>
          <button on:click={() => clearVia()}>清除接送点</button>
        </div>
      {:else}
        <button on:click={() => startPick('via')}>设置必经接送点（地图点击）</button>
      {/if}
    </div>
  {/if}
</section>

<section class="panel">
  <h2>起点</h2>
  {#if $clickMode !== 'inspect'}
    <p class="hint">正在选点（{$clickMode === 'via' ? '接送点' : '起点'}）：请在地图上点击…</p>
    <button on:click={() => cancelSnap()}>取消</button>
  {:else}
    <button class="primary" on:click={() => startPick('origin')}>在地图上点击设置起点</button>
  {/if}
  {#if $origin}
    <p class="hint">起点已吸附到路段 <code>{$origin.edgeId}</code>，蓝色虚线为吸附关系。</p>
  {/if}

  {#if $pendingSnap}
    <div class="snap-box">
      <p><b>吸附候选</b>（{$snapPurpose === 'via' ? '接送点' : '起点'}，请选择一条边）：</p>
      {#if !$pendingSnap.best}
        <p class="warn">100 米内没有可通行道路，无法吸附。该区域可能缺少道路数据。</p>
      {/if}
      {#each $pendingSnap.candidates as c}
        <label class="candidate" class:barrier={c.crossesBarrier}>
          <input type="radio" name="snap" value={c.edgeId} bind:group={chosenEdge} />
          <span>
            <b>{c.name}</b>（{c.highway}） 距离 {c.distM.toFixed(0)} m
            {#if c.crossesBarrier}<em class="badge">⚠ 连线穿过水体，疑似河对岸</em>{/if}
            <br />
            <small>候选节点：{nodeInfo(c, 0)} / {nodeInfo(c, 1)}</small>
          </span>
        </label>
      {/each}
      <div class="btn-row">
        <button class="primary" disabled={!chosenEdge} on:click={() => chooseSnap(chosenEdge)}>
          确认{$snapPurpose === 'via' ? '接送点' : '起点'}
        </button>
        <button on:click={() => cancelSnap()}>取消</button>
      </div>
    </div>
  {/if}
</section>

<section class="panel">
  <h2>求解</h2>
  <p class="hint">
    {#if $solving}
      正在求解…
    {:else if $origin}
      等时圈与路径均沿路网计算（{$settings.timeMode ? '时变 Dijkstra' : 'Dijkstra'}，Web Worker），上次用时 {$solveMs} ms。
    {:else}
      设置起点后自动求解。
    {/if}
  </p>
</section>

<div class="status">{$statusMessage}</div>

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
  button {
    font: inherit;
    padding: 5px 10px;
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
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .file-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 6px;
    margin-top: 8px;
  }
  .file-grid label {
    font-size: 12px;
    color: #4a5a48;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .file-grid input {
    font-size: 11px;
  }
  .stats {
    margin: 0;
    padding-left: 18px;
    font-size: 12px;
    color: #3c4a3a;
  }
  .hl {
    color: #a03aa0;
    font-weight: 600;
  }
  .row {
    display: block;
    font-size: 13px;
    margin: 6px 0;
  }
  .row input[type='range'] {
    width: 100%;
  }
  .row.check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .hint {
    font-size: 12px;
    color: #5a6a58;
    margin: 6px 0;
  }
  .warn {
    font-size: 12px;
    color: #a05a00;
    background: #fdf3e0;
    padding: 4px 6px;
    border-radius: 4px;
  }
  .errors {
    margin-top: 6px;
    font-size: 12px;
    color: #a02020;
    background: #fdecec;
    border: 1px solid #e5b0b0;
    border-radius: 4px;
    padding: 6px 8px;
  }
  .errors ul {
    margin: 4px 0 0;
    padding-left: 18px;
  }
  .via-box {
    margin-top: 6px;
    border-top: 1px dashed #cfd8ca;
    padding-top: 6px;
  }
  .dwell {
    width: 48px;
    font: inherit;
    font-size: 12px;
    padding: 1px 4px;
    border: 1px solid #b9c4b4;
    border-radius: 4px;
  }
  .snap-box {
    margin-top: 8px;
    border: 1px solid #cfd8ca;
    border-radius: 6px;
    padding: 8px;
    background: #fbfdfb;
    font-size: 12px;
  }
  .candidate {
    display: flex;
    gap: 6px;
    align-items: flex-start;
    padding: 4px 2px;
    border-radius: 4px;
  }
  .candidate.barrier {
    background: #fdecec;
  }
  .candidate small {
    color: #7a8a78;
  }
  .badge {
    color: #c0392b;
    font-style: normal;
    font-size: 11px;
  }
  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }
  .status {
    padding: 10px 12px;
    font-size: 12px;
    color: #4a5a48;
    background: #eef3ea;
  }
  code {
    background: #eef1ea;
    padding: 0 4px;
    border-radius: 3px;
  }
</style>
