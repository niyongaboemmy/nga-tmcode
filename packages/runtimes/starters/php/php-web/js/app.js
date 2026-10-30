// Counts the characters of every textarea that names a counter (data-counter="id").
document.querySelectorAll("textarea[data-counter]").forEach((box) => {
  const counter = document.getElementById(box.dataset.counter);
  const update = () => {
    counter.textContent = box.value.length;
  };
  box.addEventListener("input", update);
  update();
});

console.log("app.js loaded on", document.title);
