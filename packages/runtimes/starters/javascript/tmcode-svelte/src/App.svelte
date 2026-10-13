<script>
  let count = $state(0);
  let doubled = $derived(count * 2);
</script>

<main>
  <h1>Hello, Svelte</h1>
  <button onclick={() => count++}>Clicked {count} times</button>
  <p>Doubled: {doubled}</p>
</main>

<style>
  main { font-family: system-ui; text-align: center; margin-top: 4rem; }
</style>
