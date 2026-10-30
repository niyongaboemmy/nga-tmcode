<?php
require __DIR__ . '/lib/layout.php';

// The id comes from the address (post.php?id=2): turn it into a number before using it.
$post = find_post((int) ($_GET['id'] ?? 0));
if (!$post || !$post['published']) {
    http_response_code(404);
    page_start('Not found');
    echo '<h1>Post not found</h1><p><a href="index.php">Back to the posts</a></p>';
    page_end();
    exit;
}

page_start($post['title']);
?>
<article>
    <h1><?= e($post['title']) ?></h1>
    <p class="meta">Updated <?= e($post['updated']) ?></p>
    <?= nl2br(e($post['body'])) ?>
</article>
<p><a href="index.php">← All posts</a></p>
<?php page_end(); ?>
