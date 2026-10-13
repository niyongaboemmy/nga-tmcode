<script setup>
import { ref, computed } from "vue";

const items = ref([{ text: "Learn Vue", done: false }]);
const text = ref("");
const left = computed(() => items.value.filter((i) => !i.done).length);

function add() {
  if (!text.value) return;
  items.value.push({ text: text.value, done: false });
  text.value = "";
}
</script>

<template>
  <main>
    <h1>Hello, Vue</h1>
    <form @submit.prevent="add">
      <input v-model="text" placeholder="New task" />
      <button>Add</button>
    </form>
    <ul>
      <li v-for="(item, i) in items" :key="i" :class="{ done: item.done }" @click="item.done = !item.done">{{ item.text }}</li>
    </ul>
    <p>{{ left }} left</p>
  </main>
</template>

<style scoped>
main { font-family: system-ui; max-width: 400px; margin: 3rem auto; }
.done { text-decoration: line-through; color: #888; }
li { cursor: pointer; }
</style>
