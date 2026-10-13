<?php
$name = htmlspecialchars($_GET['name'] ?? 'world');
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PHP site</title>
  <style>body { font-family: system-ui; max-width: 36rem; margin: 3rem auto; }</style>
</head>
<body>
  <h1>Hello, <?= $name ?>!</h1>
  <form>
    <input name="name" placeholder="Your name">
    <button>Greet</button>
  </form>
  <p>Today is <?= date('l, j F Y') ?>. The JSON endpoint is <a href="api.php">api.php</a>.</p>
</body>
</html>
