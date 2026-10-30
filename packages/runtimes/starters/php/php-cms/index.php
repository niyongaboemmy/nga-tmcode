<?php
require __DIR__ . '/lib/layout.php';

$posts = published_posts();
page_start('Posts');
?>
<h1>Latest posts</h1>
<?php if (!$posts): ?>
    <p>No posts yet. <a href="admin/edit.php">Write the first one</a>.</p>
<?php endif; ?>
<?php foreach ($posts as $post): ?>
    <article class="card">
        <h2><a href="post.php?id=<?= $post['id'] ?>"><?= e($post['title']) ?></a></h2>
        <p class="meta"><?= e($post['updated']) ?></p>
        <p><?= e(mb_strimwidth($post['body'], 0, 160, '…')) ?></p>
    </article>
<?php endforeach; ?>
<?php page_end(); ?>
