-- Average mark per class, best first.
SELECT s.class, ROUND(AVG(m.mark), 1) AS average
FROM students s
JOIN marks m ON m.student_id = s.id
GROUP BY s.class
ORDER BY average DESC;
