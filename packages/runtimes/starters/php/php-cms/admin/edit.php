<?php
require __DIR__ . '/../lib/layout.php';
require __DIR__ . '/../lib/csrf.php';

$errors = [];
$saved = null;

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // 1. The form must come from this site (CSRF), 2. its fields must be valid, 3. then save.
    if (!csrf_valid('edit-post', $_POST['csrf'] ?? '')) {
        $errors[] = 'This form has expired or did not come from this site. Open it again and save.';
    }
    [$post, $fieldErrors] = post_from_form($_POST);
    $errors = array_merge($errors, $fieldErrors);
    if (!$errors) {
        $saved = save_post($post);
        // Post/Redirect/Get: the browser goes to the list, so Reload doesn't save twice.
        header('Location: index.php?saved=' . $saved['id'], true, 303);
    }
} else {
    $id = (int) ($_GET['id'] ?? 0);
    $post = $id ? find_post($id) : ['id' => 0, 'title' => '', 'body' => '', 'published' => false];
    if (!$post) {
        http_response_code(404);
        page_start('Not found', '../');
        echo '<h1>Post not found</h1><p><a href="index.php">Back to the posts</a></p>';
        page_end();
        exit;
    }
}

page_start($post['id'] ? 'Edit post' : 'New post', '../');
?>
<?php if ($saved): ?>
    <h1>Saved</h1>
    <p>“<?= e($saved['title']) ?>” is saved. <a href="index.php">Back to all posts</a></p>
    <?php if (PHP_SAPI === 'cli'): ?>
        <p class="note">This page ran on the school's code runner, where every page starts fresh: the post isn't kept. Run the site with PHP on your computer to keep it.</p>
    <?php endif; ?>
<?php else: ?>
    <h1><?= $post['id'] ? 'Edit post' : 'New post' ?></h1>
    <?php if ($errors): ?>
        <ul class="errors">
            <?php foreach ($errors as $error): ?>
                <li><?= e($error) ?></li>
            <?php endforeach; ?>
        </ul>
    <?php endif; ?>
    <form class="card" method="post" action="edit.php">
        <?= csrf_field('edit-post') ?>
        <input type="hidden" name="id" value="<?= (int) $post['id'] ?>">
        <label>Title <input name="title" value="<?= e($post['title']) ?>" required maxlength="120"></label>
        <label>Text <textarea name="body" rows="8" required><?= e($post['body']) ?></textarea></label>
        <label class="inline"><input type="checkbox" name="published" value="1" <?= $post['published'] ? 'checked' : '' ?>> Published (visitors can see it)</label>
        <button type="submit">Save</button>
    </form>
<?php endif; ?>
<?php page_end(); ?>
