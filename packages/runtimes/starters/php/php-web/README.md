# PHP – Website with HTML, CSS & JavaScript

A small website: every page is a `.php` file that starts with HTML.

- `index.php` and `about.php` are pages. Both include `includes/header.php` and `includes/footer.php`, so the menu is written once.
- `css/style.css` styles every page; `js/app.js` adds a little behaviour (the form counts the characters of your message).
- The form on `index.php` posts to `contact.php`. PHP checks the fields and shows them back with `htmlspecialchars()`, so what someone types is shown as text, never run as HTML.

Run it:

- **Run** (▶) starts PHP's built-in web server (`php -S localhost:8000`) when PHP is on this computer, and opens the page you are editing.
- Without PHP, TMCode runs the pages on the school's code runner: the page opens in the preview and its links and form work.
