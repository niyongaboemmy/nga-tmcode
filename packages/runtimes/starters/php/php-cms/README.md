# PHP – Small CMS (posts in a JSON file)

A tiny content management system, in plain PHP:

- `index.php` lists the published posts; `post.php?id=…` shows one.
- `admin/index.php` lists every post (drafts too); `admin/edit.php` adds a post or edits one.
- The posts are kept in `data/posts.json`. `lib/posts.php` reads and writes that file, so no page touches it directly.

What it teaches:

- **Escaping:** everything a person typed is printed with `e()` (`htmlspecialchars`), so it shows as text and never runs as HTML or JavaScript.
- **Validation:** the form's fields are checked on the server, and the form comes back with the errors and what was typed.
- **CSRF tokens:** the admin form carries a signed, time-limited token (`lib/csrf.php`); a form posted from another site has no valid token and is refused. Changes only ever happen on POST.
- **Post/Redirect/Get:** after saving, the browser is sent to the post list, so Reload doesn't save twice.

Before you put it online, change `SECRET` in `lib/config.php` and protect `admin/` with a login.

Run it:

- **Run** (▶) starts PHP's built-in web server (`php -S localhost:8000`) when PHP is on this computer. Saved posts are kept in `data/posts.json`.
- Without PHP, TMCode runs the pages on the school's code runner. Every page runs fresh there, so a saved post is shown once but not kept: install PHP to keep your changes.
