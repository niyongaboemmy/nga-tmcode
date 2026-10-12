-- ⌘/Ctrl+Shift+Enter runs the whole file; ⌘/Ctrl+Enter runs the query under the cursor.

-- 1. Everyone, best average first
SELECT s.name, s.class, ROUND(AVG(m.score), 1) AS average, COUNT(*) AS subjects
FROM students s
JOIN marks m ON m.student_id = s.id
GROUP BY s.id
ORDER BY average DESC;

-- 2. The top mark in each subject
SELECT sub.title, st.name, m.score
FROM marks m
JOIN subjects sub ON sub.id = m.subject_id
JOIN students st ON st.id = m.student_id
WHERE m.score = (SELECT MAX(score) FROM marks WHERE subject_id = m.subject_id);

-- 3. Who has no Physics mark? (LEFT JOIN … IS NULL)
SELECT s.name
FROM students s
LEFT JOIN marks m ON m.student_id = s.id AND m.subject_id = (SELECT id FROM subjects WHERE title = 'Physics')
WHERE m.student_id IS NULL;

-- 4. Class averages with a window function
SELECT DISTINCT s.class, ROUND(AVG(m.score) OVER (PARTITION BY s.class), 1) AS class_average
FROM students s JOIN marks m ON m.student_id = s.id;
