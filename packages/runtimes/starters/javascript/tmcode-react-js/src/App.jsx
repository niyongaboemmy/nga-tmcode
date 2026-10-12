import { useState } from "react";

export default function App() {
  const [items, setItems] = useState(["Learn JSX"]);
  const [text, setText] = useState("");
  return (
    <main style={{ fontFamily: "system-ui", maxWidth: 400, margin: "3rem auto" }}>
      <h1>My list</h1>
      <form onSubmit={(e) => { e.preventDefault(); if (text) setItems([...items, text]); setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} />
        <button>Add</button>
      </form>
      <ul>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </main>
  );
}
