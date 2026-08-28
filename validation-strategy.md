# Validation Strategy

## Goal

Treat Effect Domains as a design hypothesis to test through narrow vertical slices. Each slice should be complete enough to expose semantic differences between the domain, behavior, storage, and transport instead of demonstrating schema syntax alone. ([Project thesis](raw/project-thesis.md))

## Required Shape of a Slice

Each experiment should include:

1. branded domain values;
2. an entity with a meaningful state transition;
3. a business operation with typed domain errors;
4. a database representation;
5. a versioned wire representation;
6. explicit transformations wherever representations differ; and
7. a historical database migration.

These elements are required by the source thesis because they test both derivable structure and concerns that must remain authored. ([Project thesis](raw/project-thesis.md))

## Evaluation Questions

For every slice, record:

- How much duplicate declaration disappeared?
- Did domain changes propagate safely?
- How much annotation machinery was required?
- Were escape hatches straightforward?
- Is the result easier to understand than handwritten adapters?

Compare evidence across materially different domains before extracting a general algebra. One successful slice can validate a technique, but it cannot establish that the technique generalizes. ([Project thesis](raw/project-thesis.md))

## Evidence Standard

An experiment page should link to its implementation and tests, state what was authored versus derived, and answer each evaluation question. It should also report failures and awkward cases rather than presenting only the successful path. This reporting format is **wiki analysis** derived from the thesis’s evaluation criteria; it is not an additional claim from the source.

## Current Gap

No qualifying vertical slice is documented yet. The immediate need is to choose a first domain that contains a real state transition and meaningful divergence among domain, storage, and wire representations. Candidate selection remains a human architectural judgment. See the [Research Agenda](research-agenda.md).
