<script lang="ts">
  import { facilitiesView, selectedFacility, selectedFacilityId, settings } from '../lib/stores';
  import { fmtClock } from '../lib/td';
  import { STATUS_TEXT, type ReachStatus } from '../lib/types';

  const CHIP_COLORS: Record<ReachStatus | 'none', string> = {
    ok: '#1a9850',
    'beyond-time': '#fdae61',
    disconnected: '#d73027',
    'stairs-only': '#7b3294',
    'data-gap': '#9e9e9e',
    'outside-extent': '#542788',
    'via-unreachable': '#c2185b',
    none: '#2b83ba'
  };

  const EXPLAIN: Record<ReachStatus, string> = {
    ok: '沿路网步行可达。',
    'beyond-time': '路网连通，但最短步行时间超出当前时间上限。可尝试提高步速、放宽时间上限或提前出发。',
    disconnected: '设施所在路段与起点不在同一连通分量（路网断开、河流阻隔或单行道限制），在现有路网上确定不可达。',
    'stairs-only': '与起点之间仅有台阶相连；台阶已按禁行处理，因此不可达。',
    'data-gap': '距最近可通行道路超过 100 米，周边可能缺少道路数据。这不是确定不可达，需补充数据后再判断。',
    'outside-extent': '位于数据范围之外，缺少该区域的路网数据，不能解释为不可达。',
    'via-unreachable': '必经接送点在当前时界内不可达，第二段行程无从谈起。'
  };

  function chipLabel(status: ReachStatus | 'none'): string {
    return status === 'none' ? '未求解' : STATUS_TEXT[status];
  }
</script>

<section class="panel">
  <h2>设施（{$facilitiesView.length}）</h2>
  {#if $facilitiesView.length === 0}
    <p class="hint">尚未加载设施数据。</p>
  {/if}
  <ul class="list">
    {#each $facilitiesView as f}
      <li>
        <button
          class="row"
          class:selected={$selectedFacilityId === f.id}
          on:click={() => selectedFacilityId.set(f.id)}
        >
          <span class="chip" style="background:{CHIP_COLORS[f.result?.status ?? 'none']}"></span>
          <span class="name">{f.name}</span>
          <span class="cat">{f.category}</span>
          <span class="time">
            {#if $settings.timeMode && f.result?.arrivalMin !== undefined}
              {fmtClock(f.result.arrivalMin)}
            {:else if f.result?.timeMin !== undefined}
              {f.result.timeMin}′
            {/if}
          </span>
        </button>
      </li>
    {/each}
  </ul>

  {#if $selectedFacility}
    {@const sel = $selectedFacility}
    <div class="detail">
      <h3>{sel.name} <span class="cat">{sel.category}</span></h3>
      {#if sel.result}
        {@const r = sel.result}
        <p><b>{chipLabel(r.status)}</b></p>
        {#if r.timeMin !== undefined}
          <p>
            全程约 <b>{r.timeMin}</b> 分钟{#if r.arrivalMin !== undefined}，<b>{fmtClock(r.arrivalMin)}</b> 到达{/if}（粉色线为路径）。
          </p>
        {/if}
        {#if r.waitMin}
          <p>途中等待合计 {r.waitMin.toFixed(1)} 分钟。</p>
        {/if}
        {#if r.waits && r.waits.length > 0}
          <ul class="waits">
            {#each r.waits as w}
              <li>
                {fmtClock(w.clockMin)} 起在「{w.label}」{w.kind === 'dwell' ? '停留' : '等待'} {w.waitMin.toFixed(1)} 分钟
              </li>
            {/each}
          </ul>
        {/if}
        {#if r.snapDistM !== undefined}
          <p>设施到路网的吸附距离 {r.snapDistM} 米。</p>
        {/if}
        <p class="explain">{EXPLAIN[r.status]}</p>
      {:else}
        <p class="explain">尚未求解（请先设置起点）。</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .panel {
    padding: 10px 12px;
  }
  h2 {
    font-size: 13px;
    margin: 0 0 8px;
    color: #3c4a3a;
    letter-spacing: 0.05em;
  }
  .list {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 260px;
    overflow-y: auto;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 5px 6px;
    border: none;
    background: none;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    border-radius: 4px;
    text-align: left;
  }
  .row:hover {
    background: #eef3ea;
  }
  .row.selected {
    background: #dce9dc;
  }
  .chip {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: none;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cat {
    color: #8a9a86;
    font-size: 11px;
  }
  .time {
    color: #3c4a3a;
    font-variant-numeric: tabular-nums;
    min-width: 32px;
    text-align: right;
  }
  .detail {
    margin-top: 8px;
    border-top: 1px solid #dde3da;
    padding-top: 8px;
    font-size: 12px;
  }
  .detail h3 {
    font-size: 13px;
    margin: 0 0 6px;
  }
  .detail p {
    margin: 4px 0;
  }
  .waits {
    margin: 4px 0;
    padding-left: 18px;
    color: #8a5a00;
  }
  .explain {
    color: #5a6a58;
    background: #f2f6ef;
    padding: 6px 8px;
    border-radius: 4px;
  }
  .hint {
    font-size: 12px;
    color: #5a6a58;
  }
</style>
