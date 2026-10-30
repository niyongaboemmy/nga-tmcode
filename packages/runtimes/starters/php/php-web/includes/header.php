<?php
require_once __DIR__ . '/functions.php';
// Each page sets $title before including this file.
$title = $title ?? 'My PHP website';
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title><?= e($title) ?></title>
    <link rel="stylesheet" href="css/style.css">
</head>
<body>
<header class="site-header">
    <a class="logo" href="index.php">My PHP website</a>
    <nav>
        <a href="index.php">Home</a>
        <a href="about.php">About</a>
    </nav>
</header>
<main>
