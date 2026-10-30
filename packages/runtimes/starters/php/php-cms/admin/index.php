<?php
require __DIR__ . '/../lib/layout.php';

page_start('Admin', '../');
?>
<h1>All posts</h1>
<p><a class="button" href="edit.php">+ New post</a></p>
<table>
    <thead>
        <tr><th>Title</th><th>State</th><th>Updated</th><th></th></tr>
    </thead>
    <tbody>
    <?php foreach (all_posts() as $post): ?>
        <tr>
            <td><?= e($post['title']) ?></td>
            <td><?= $post['published'] ? 'Published' : 'Draft' ?></td>
            <td><?= e($post['updated']) ?></td>
            <td><a href="edit.php?id=<?= $post['id'] ?>">Edit</a></td>
        </tr>
    <?php endforeach; ?>
    </tbody>
</table>
<?php page_end(); ?>
