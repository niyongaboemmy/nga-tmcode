<?php
require_once __DIR__ . '/config.php';

/*
 * CSRF tokens: a form of this site carries a token that only this site can make (it is signed
 * with SECRET) and that expires. A page on another site can make the visitor's browser post to
 * admin/edit.php, but it can't make a valid token, so the change is refused.
 * A site with logins also ties the token to the logged-in user's session.
 */

const TOKEN_LIFETIME = 2 * 60 * 60; // two hours

/** A new token for the form named $form ("edit-post"). */
function csrf_token(string $form): string
{
    $time = (string) time();
    return $time . '.' . hash_hmac('sha256', $form . '|' . $time, SECRET);
}

/** Whether $token is a valid, unexpired token for the form named $form. */
function csrf_valid(string $form, string $token): bool
{
    [$time, $signature] = array_pad(explode('.', $token, 2), 2, '');
    if (!ctype_digit($time) || time() - (int) $time > TOKEN_LIFETIME) {
        return false;
    }
    // hash_equals: compares in constant time, so the signature can't be guessed bit by bit.
    return hash_equals(hash_hmac('sha256', $form . '|' . $time, SECRET), $signature);
}

/** The hidden field to put inside a form. */
function csrf_field(string $form): string
{
    return '<input type="hidden" name="csrf" value="' . htmlspecialchars(csrf_token($form), ENT_QUOTES, 'UTF-8') . '">';
}
