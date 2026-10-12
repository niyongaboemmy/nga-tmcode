# SQL – Filter and sort (PostgreSQL)

Write one SELECT against a small students table in a real PostgreSQL database; the expected result is checked.

Runs on the school runner's container tier: every run gets its own PostgreSQL server with `schema.sql` and `seed.sql` loaded, and every test starts from a fresh copy.
Run locally: load `schema.sql` and `seed.sql` into a database named `app`, then `psql -X -q -P border=2 -P footer=off -f main.sql`.
Tests: the expected result in `.nga/tests.json`.
