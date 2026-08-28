# Research Agenda

This page records **wiki analysis and unresolved questions**. The source thesis establishes the constraints, but it does not answer the questions below. ([Project thesis](raw/project-thesis.md))

## First Capability: Persistence

Persistence is the first desired product capability. Its public surface must accept declarative descriptions, compile them into Effect programs, and express the runtime database dependency through an interface requirement. A concrete database remains a runtime-provided implementation rather than part of the public contract. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

Planning still needs to resolve:

- the smallest persistence declaration a user must author;
- which storage mappings and row codecs can be derived losslessly from an Effect Schema;
- the exact semantics promised by the runtime persistence interface;
- which insert, retrieve, update, or delete operations belong in the first complete capability;
- how adapter contract tests prove that implementations satisfy the interface; and
- where explicit semantic transformations sit without turning the normal interface procedural.

A later validation slice must exercise these decisions in a domain approved by the human. The project must not infer a product domain from illustrative examples in the thesis.

## Effect Schema Capabilities

The project needs source-backed answers to these implementation questions:

- Which Effect Schema inspection APIs are stable enough for interpreter authors?
- How are brands, transformations, annotations, optional fields, unions, and recursive schemas represented at runtime?
- Which behavior can be derived without depending on undocumented schema internals?
- What limitations appear when deriving database constraints or versioned codecs?

These questions require current Effect documentation and prototype evidence before the wiki can state conclusions.

## Interpreter Interface

Interpreters must receive declarative domain descriptions while keeping persistence and transport details out of the canonical schema. Experiments must still determine:

- how a sidecar declaration requests only essential concern-specific information;
- when configuration or annotations become a second embedded programming language;
- how Effect requirements expose infrastructure needs without leaking one adapter into the interface;
- how escape hatches compose with the derived path; and
- whether one shared algebra is clearer than several narrow interpreters.

The declarative interface and Effect requirement constraints are established project direction; the precise declaration and service shapes remain open. ([Effect and declarative interface direction](raw/effect-and-declarative-interface-direction.md))

## Success and Stop Conditions

The [Validation Strategy](validation-strategy.md) gives evaluation questions, but quantitative or practical thresholds are not defined. Before generalizing, the project should decide what amount of removed duplication justifies the machinery and what signs should stop framework extraction. A valid outcome may be a set of domain-specific patterns rather than a general meta-framework.
