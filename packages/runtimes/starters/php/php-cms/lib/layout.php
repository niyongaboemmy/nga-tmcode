<?php
require_once __DIR__ . '/posts.php';

/** The top of every page. $base: the way back to the site's folder ("" or "../"). */
function page_start(string $title, string $base = ''): void
{
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($title) ?> · <?= e(SITE_NAME) ?></title>
    <link rel="stylesheet" href="<?= $base ?>css/style.css">
</head>
<body>
<header class="site-header">
    <a class="logo" href="<?= $base ?>index.php"><?= e(SITE_NAME) ?></a>
    <nav>
        <a href="<?= $base ?>index.php">Posts</a>
        <a href="<?= $base ?>admin/index.php">Admin</a>
    </nav>
</header>
<main>
    <?php
}

/** The bottom of every page. */
function page_end(): void
{
    ?>
</main>
</body>
</html>
    <?php
}
