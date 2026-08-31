# Table and Query API Direction

The human set the following newer direction for persistence interfaces:

- “Table.make(<schema>, <config>) should be the api for tables”
- “Query.make(<table>, <config>) should be the api for queries (CRUD, etc)”
- Each `Query.make` defines one operation. It has no operation `type` parameter.
- The user provides the query implementation.
- The implementation returns an Effect. The database is an Effect requirement and is therefore supplied only when the query is run, not declared as a separate query configuration field.

This direction supersedes the earlier `Persistence.define` catalog interface and its catalog-key-as-capability rule. It retains the earlier rules that identity comes from `Domain.identifier`, encoded field names become columns, fresh table creation is mechanically derived, and migrations remain explicit.
