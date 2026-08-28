# Research Agenda

This page records **wiki analysis and unresolved questions**. The source thesis establishes the constraints, but it does not answer the questions below. ([Project thesis](raw/project-thesis.md))

## First Vertical Slice

Choose a domain small enough to implement quickly but rich enough to include:

- a meaningful policy-controlled state transition;
- typed business errors;
- persistence details that do not exactly match the domain;
- a versioned transport representation; and
- a migration with historical meaning.

The choice should expose the derivation boundary rather than favor a model where every representation is trivially identical. The human must approve the domain because this choice determines which architectural pressures the first experiment reveals.

## Effect Schema Capabilities

The project needs source-backed answers to these implementation questions:

- Which Effect Schema inspection APIs are stable enough for interpreter authors?
- How are brands, transformations, annotations, optional fields, unions, and recursive schemas represented at runtime?
- Which behavior can be derived without depending on undocumented schema internals?
- What limitations appear when deriving database constraints or versioned codecs?

These questions require current Effect documentation and prototype evidence before the wiki can state conclusions.

## Interpreter Interface

Experiments must determine how interpreters receive domain descriptions while keeping persistence and transport details out of the canonical schema. Key unknowns are:

- how an interpreter requests essential concern-specific information;
- when annotations remain lightweight versus becoming a second embedded schema language;
- how escape hatches compose with the derived path; and
- whether one shared algebra is clearer than several narrow interpreters.

## Success and Stop Conditions

The [Validation Strategy](validation-strategy.md) gives evaluation questions, but quantitative or practical thresholds are not defined. Before generalizing, the project should decide what amount of removed duplication justifies the machinery and what signs should stop framework extraction. A valid outcome may be a set of domain-specific patterns rather than a general meta-framework.
