-- dialect: postgres
-- Students in class S4B, by name.
SELECT name, class
FROM students
WHERE class = 'S4B'
ORDER BY name;
