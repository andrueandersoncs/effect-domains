# Derived Table Creation Direction

Effect Domains should provide table creation in the same declarative way that it provides CRUD.

Fresh table creation is mechanically derivable from the accepted persistence declaration:

- the catalog key supplies the table name;
- encoded schema fields supply column names and scalar types;
- required struct fields supply non-null constraints; and
- `Domain.identifier` supplies the primary key.

This derived operation creates a fresh physical table. It does not derive migrations for an existing table; migration semantics and data transitions remain explicit.
