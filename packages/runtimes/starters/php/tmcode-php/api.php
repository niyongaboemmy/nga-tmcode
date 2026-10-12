<?php
header('Content-Type: application/json');
$todos = [['id' => 1, 'title' => 'Learn PHP', 'done' => false]];
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
    $body = json_decode(file_get_contents('php://input'), true) ?? [];
    if (empty($body['title'])) {
        http_response_code(400);
        echo json_encode(['error' => 'title is required']);
        exit;
    }
    http_response_code(201);
    echo json_encode(['id' => 2, 'title' => $body['title'], 'done' => false]);
    exit;
}
echo json_encode($todos);
