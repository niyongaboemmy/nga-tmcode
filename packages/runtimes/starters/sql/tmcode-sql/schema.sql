-- Tables. Fresh runs of queries.sql build these first.
CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  class TEXT NOT NULL
);

CREATE TABLE subjects (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL UNIQUE
);

CREATE TABLE marks (
  student_id INTEGER NOT NULL REFERENCES students(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(id),
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  PRIMARY KEY (student_id, subject_id)
);
