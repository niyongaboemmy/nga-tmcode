<?php
$title = 'Home';
$courses = ['HTML', 'CSS', 'JavaScript', 'PHP'];
require __DIR__ . '/includes/header.php';
?>
<h1>Welcome!</h1>
<p>This page is HTML with a little PHP inside. Today is <strong><?= date('l, j F Y') ?></strong>.</p>

<h2>What this site uses</h2>
<ul>
    <?php foreach ($courses as $course): ?>
        <li><?= e($course) ?></li>
    <?php endforeach; ?>
</ul>

<h2>Contact us</h2>
<form class="card" method="post" action="contact.php">
    <label>Your name <input name="name" required maxlength="60"></label>
    <label>Email <input name="email" type="email" required></label>
    <label>Message
        <textarea name="message" rows="4" required maxlength="500" data-counter="message-count"></textarea>
    </label>
    <p class="hint"><span id="message-count">0</span>/500 characters</p>
    <button type="submit">Send</button>
</form>
<?php require __DIR__ . '/includes/footer.php'; ?>
