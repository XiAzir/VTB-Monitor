<script lang="ts">
  import '../styles/app.css';
  import { Activity, Shield } from '@lucide/svelte';
  let { children } = $props();
</script>

<svelte:head>
  <title>监控室老大爷</title>
  <meta name="description" content="B站主播动态、周表与开播时间监控" />
</svelte:head>

<header class="site-header">
  <a class="brand" href="/" aria-label="监控室老大爷首页">
    <span class="brand-mark"><Activity size={19} strokeWidth={2.2} /></span>
    <span>监控室老大爷</span>
  </a>
  <nav aria-label="主导航">
    <a href="/">监控台</a>
    <a class="icon-link" href="/admin" title="后台管理" aria-label="后台管理"><Shield size={18} /></a>
  </nav>
</header>

<main>{@render children()}</main>
