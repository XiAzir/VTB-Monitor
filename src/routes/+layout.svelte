<script lang="ts">
  import '../styles/app.css';
  import { Inbox, LayoutGrid, Shield } from '@lucide/svelte';
  import { page } from '$app/state';
  let { children } = $props();
</script>

<svelte:head>
  <title>监控室老大爷</title>
  <meta name="description" content="B站主播动态、周表与开播时间监控" />
</svelte:head>

<header class="site-header">
  <a class="brand" href="/" aria-label="监控室老大爷首页">
    <span class="brand-mark"><Inbox size={19} strokeWidth={2.2} /></span>
    <span class="brand-text">监控室老大爷</span>
  </a>
  <nav aria-label="主导航">
    <a href="/" aria-current={page.url.pathname === '/' ? 'page' : undefined}><LayoutGrid size={15} /> 监控台</a>
    <a class="button primary" href="/admin" aria-label="后台管理"><Shield size={14} /> 后台</a>
  </nav>
</header>

<main>{@render children()}</main>

<style>
  @media (max-width: 640px) { .brand-text { display: none; } }
</style>
