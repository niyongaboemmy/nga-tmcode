<?php
$title = 'Contact';
require __DIR__ . '/includes/header.php';

// Only a form sent with POST is handled here; opening the page directly shows a link back.
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo '<p>Use the form on the <a href="index.php">home page</a>.</p>';
    require __DIR__ . '/includes/footer.php';
    exit;
}

// Read the fields: trim spaces, and never trust what was sent.
$name = trim($_POST['name'] ?? '');
$email = trim($_POST['email'] ?? '');
$message = trim($_POST['message'] ?? '');

$errors = [];
if ($name === '' || mb_strlen($name) > 60) {
    $errors[] = 'Enter your name (60 characters at most).';
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    $errors[] = 'Enter a valid email address.';
}
if ($message === '' || mb_strlen($message) > 500) {
    $errors[] = 'Write a message (500 characters at most).';
}
?>
<?php if ($errors): ?>
    <h1>Please check the form</h1>
    <ul class="errors">
        <?php foreach ($errors as $error): ?>
            <li><?= e($error) ?></li>
        <?php endforeach; ?>
    </ul>
    <p><a href="index.php">Back to the form</a></p>
<?php else: ?>
    <h1>Thank you, <?= e($name) ?>!</h1>
    <p>We will answer at <strong><?= e($email) ?></strong>. Your message:</p>
    <blockquote><?= nl2br(e($message)) ?></blockquote>
    <p><a href="index.php">Back to the home page</a></p>
<?php endif; ?>
<?php require __DIR__ . '/includes/footer.php'; ?>
