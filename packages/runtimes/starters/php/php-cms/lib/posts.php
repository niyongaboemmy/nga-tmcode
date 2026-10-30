<?php
require_once __DIR__ . '/config.php';

/** Text made safe to print inside HTML: <, >, & and quotes become entities. */
function e(?string $text): string
{
    return htmlspecialchars($text ?? '', ENT_QUOTES, 'UTF-8');
}

/** Every post, newest first. A post: id, title, body, published (true/false), updated (date). */
function all_posts(): array
{
    $json = is_file(POSTS_FILE) ? file_get_contents(POSTS_FILE) : '[]';
    $posts = json_decode($json, true);
    if (!is_array($posts)) {
        return [];
    }
    usort($posts, fn ($a, $b) => strcmp($b['updated'], $a['updated']));
    return $posts;
}

/** The published posts only (what visitors see). */
function published_posts(): array
{
    return array_values(array_filter(all_posts(), fn ($p) => $p['published']));
}

/** One post by its id, or null. */
function find_post(int $id): ?array
{
    foreach (all_posts() as $post) {
        if ($post['id'] === $id) {
            return $post;
        }
    }
    return null;
}

/** Adds a post (no id) or replaces the post with the same id; returns the saved post. */
function save_post(array $post): array
{
    $posts = all_posts();
    $post['updated'] = date('Y-m-d H:i');
    if (empty($post['id'])) {
        $post['id'] = $posts ? max(array_column($posts, 'id')) + 1 : 1;
        $posts[] = $post;
    } else {
        foreach ($posts as $i => $old) {
            if ($old['id'] === $post['id']) {
                $posts[$i] = $post;
            }
        }
    }
    // LOCK_EX: two saves at the same moment can't mix their writes.
    file_put_contents(POSTS_FILE, json_encode(array_values($posts), JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n", LOCK_EX);
    return $post;
}

/** The fields of a post form, checked: [post, errors]. */
function post_from_form(array $form): array
{
    $post = [
        'id' => (int) ($form['id'] ?? 0),
        'title' => trim($form['title'] ?? ''),
        'body' => trim($form['body'] ?? ''),
        'published' => ($form['published'] ?? '') === '1',
    ];
    $errors = [];
    if ($post['title'] === '' || mb_strlen($post['title']) > 120) {
        $errors[] = 'Give the post a title (120 characters at most).';
    }
    if ($post['body'] === '') {
        $errors[] = 'Write the post.';
    }
    return [$post, $errors];
}
