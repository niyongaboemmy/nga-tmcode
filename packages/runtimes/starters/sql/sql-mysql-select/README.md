# SQL – Filter and sort (MySQL)

Write one SELECT against a small students table in a real MySQL database; the expected result is checked.

Runs on the school runner's container tier: every run gets its own MySQL server with `schema.sql` and `seed.sql` loaded, and every test starts from a fresh copy.
Run locally: load `schema.sql` and `seed.sql` into a database named `app`, then `mysql --table app < main.sql`.
Tests: the expected result in `.nga/tests.json`.
