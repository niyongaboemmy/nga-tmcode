<?php

/** Text made safe to print inside HTML: <, >, & and quotes become entities. */
function e(string $text): string
{
    return htmlspecialchars($text, ENT_QUOTES, 'UTF-8');
}
