<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<title>EdgeAI Playground</title>
	<link rel="icon" href={favicon} />
	<link rel="stylesheet" href="/app.css" />
</svelte:head>

<div class="app-shell">
	<main class="app-main">
		{@render children()}
	</main>

	<footer class="site-footer" aria-label="网站备案信息">
		<a href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">皖ICP备2025107155号</a>
	</footer>
</div>
