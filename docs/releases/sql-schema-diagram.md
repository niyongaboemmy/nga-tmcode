**See a database at a glance: .sql files preview as an interactive schema diagram.** Open a schema or a database dump (mysqldump, phpMyAdmin, pg_dump, SQLite), click **Preview** above it, and TMCode draws every table, view and foreign key, like MySQL Workbench's EER diagram. Drag tables around, search, click one for all its details, and export the whole diagram as PNG, PDF or SVG.

### The diagram

- **Edit | Preview** above every `.sql` file, as Markdown and CSV files already have. Edit stays the default.
- **Each table is a card:** its name, how many columns, the table comment, and each column with its type.
  - a key for the primary key, an arrow for a foreign key, a filled diamond for NOT NULL and an empty one for nullable;
  - small badges: **UQ** unique · **IX** indexed · **AI** auto-increment · **DF** default · **GC** generated.
  - Hover a column for everything about it (default, ON UPDATE, comment…).
- **Views** are cards of their own (marked VIEW), with dotted lines to the tables they read.
- **Relationship lines** go from the foreign key column to the column it references, with crow's-foot ends:
  - a crow's foot means many, a bar means one, a ring means optional;
  - a dashed line is a nullable foreign key; a foreign key that is also unique (or the primary key) is one-to-one.
- **Automatic layout:** referenced tables sit left of the tables that reference them, crossings are kept low, and a table referenced by many (like `users`) doesn't make one endless column. Tables without relationships are grouped at the end.

### Moving around

- **Pan:** drag the background or scroll. **Zoom:** pinch, ⌘/Ctrl + scroll, the − / + buttons, or the − + 0 keys. **Fit to Screen** shows everything.
- **Zoomed far out**, columns become bars and table names grow so you can still read the map.
- **Drag tables** to arrange them. TMCode remembers where you put them for each file; **Reset Layout** goes back to the automatic one.
- **Find a table or column:** matching tables stand out; Enter goes to each in turn.
- **Keys Only** hides every column that isn't a key, for big schemas (on by default above 80 tables).
- **A minimap** in the corner shows where you are; click or drag it to move.

### Details

- **Click a table** to light it up with its neighbours and open its details beside the diagram: every column (type, NULL / NOT NULL, default, auto-increment, enum values, check, comment), keys and indexes, the foreign keys it has and the ones that point to it, with their ON DELETE / ON UPDATE rules. Click a linked table to go there.
- **Click a line** for that relationship: the columns on both sides, its cardinality in words and its rules.
- **Line N** links go to the CREATE statement in the editor.

### Export

- **PNG, PDF or SVG** of the whole diagram, not just what's on screen, in the current theme's colours.
- On the desktop app, a Save dialog asks where; in the browser the file downloads.

### What it reads

- `CREATE TABLE` with backticked, double-quoted or [bracketed] names, schema-qualified names (`public.orders`), comments, inline and table-level `PRIMARY KEY` / `UNIQUE` / `FOREIGN KEY … REFERENCES … ON DELETE / ON UPDATE`, `CONSTRAINT` names, `CHECK`, `DEFAULT`, `NOT NULL`, `AUTO_INCREMENT` / `SERIAL` / `IDENTITY` / `GENERATED`, `KEY` / `INDEX` / `FULLTEXT` lines, `ENUM` and `SET`, column and table `COMMENT`s.
- `ALTER TABLE … ADD` (constraints, keys, columns), `MODIFY` / `CHANGE`, `ALTER COLUMN … SET NOT NULL / DEFAULT`, `DROP`; `CREATE INDEX`; `CREATE VIEW` (also mysqldump's views inside `/*!50001 … */`) and materialized views; PostgreSQL `CREATE TYPE … AS ENUM` and `COMMENT ON`.
- **Big dumps are fine:** `INSERT` and `COPY` data, triggers and functions are stepped over without being read, so a dump of tens of MB is drawn in about a second while the window stays responsive.
- **Nothing hidden:** what couldn't be read (a broken statement, a foreign key to a table that isn't in the file) is listed under **N skipped**, with a link to its line. A file without `CREATE TABLE` says so.
