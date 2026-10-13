const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const player = { x: 220, y: 140, size: 24, speed: 4 };
let dot = spawn();
let score = 0;
const keys = new Set();
addEventListener("keydown", (e) => keys.add(e.key));
addEventListener("keyup", (e) => keys.delete(e.key));

function spawn() {
  return { x: 20 + Math.random() * 440, y: 20 + Math.random() * 280 };
}

function update() {
  if (keys.has("ArrowLeft")) player.x -= player.speed;
  if (keys.has("ArrowRight")) player.x += player.speed;
  if (keys.has("ArrowUp")) player.y -= player.speed;
  if (keys.has("ArrowDown")) player.y += player.speed;
  player.x = Math.max(0, Math.min(canvas.width - player.size, player.x));
  player.y = Math.max(0, Math.min(canvas.height - player.size, player.y));
  const cx = player.x + player.size / 2;
  const cy = player.y + player.size / 2;
  if (Math.hypot(cx - dot.x, cy - dot.y) < player.size / 2 + 6) {
    score++;
    dot = spawn();
  }
}

function draw() {
  ctx.fillStyle = "#1e1e2e";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#89b4fa";
  ctx.fillRect(player.x, player.y, player.size, player.size);
  ctx.fillStyle = "#f9e2af";
  ctx.beginPath();
  ctx.arc(dot.x, dot.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#cdd6f4";
  ctx.font = "16px system-ui";
  ctx.fillText("Score: " + score, 10, 22);
}

function loop() {
  update();
  draw();
  requestAnimationFrame(loop);
}
loop();
