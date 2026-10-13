-- Students and their marks.
CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  class TEXT NOT NULL
);

CREATE TABLE marks (
  student_id INTEGER NOT NULL REFERENCES students(id),
  subject TEXT NOT NULL,
  mark INTEGER NOT NULL CHECK (mark BETWEEN 0 AND 100)
);
