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
</div>
