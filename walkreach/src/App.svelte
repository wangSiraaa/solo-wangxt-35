<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import MapView from './components/MapView.svelte';
  import ControlPanel from './components/ControlPanel.svelte';
  import FacilityList from './components/FacilityList.svelte';
  import ScenarioPanel from './components/ScenarioPanel.svelte';
  import { initController, loadDemo, scheduleSolve } from './lib/controller';
  import { settings } from './lib/stores';

  let unsub: (() => void) | null = null;

  onMount(() => {
    initController();
    void loadDemo();
    // 参数变化后自动重算
    unsub = settings.subscribe(() => scheduleSolve());
  });

  onDestroy(() => unsub?.());
</script>

<div class="layout">
  <aside>
    <header>
      <h1>步行可达性分析</h1>
      <p>沿路网计算 · 纯本地数据 · 无外部地图密钥</p>
    </header>
    <div class="scroll">
      <ControlPanel />
      <ScenarioPanel />
      <FacilityList />
    </div>
  </aside>
  <main>
    <MapView />
  </main>
</div>

<style>
  .layout {
    display: grid;
    grid-template-columns: 350px 1fr;
    height: 100vh;
  }
  aside {
    display: flex;
    flex-direction: column;
    border-right: 1px solid #d5ddd2;
    background: #f8faf6;
    min-height: 0;
  }
  header {
    padding: 12px;
    border-bottom: 1px solid #dde3da;
    background: #2f6f4f;
    color: #fff;
  }
  header h1 {
    font-size: 16px;
    margin: 0;
  }
  header p {
    font-size: 11px;
    margin: 4px 0 0;
    opacity: 0.85;
  }
  .scroll {
    overflow-y: auto;
    flex: 1;
  }
  main {
    position: relative;
    min-width: 0;
  }
</style>
