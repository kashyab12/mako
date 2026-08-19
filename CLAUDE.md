@AGENTS.md

# Required checks

Mako is a provider-neutral meta-harness. Do not introduce public Pi names or a privileged provider path.

Before handing off any source change, run `npm run lint`. Oxlint anti-slop must remain at zero warnings and zero errors; do not suppress or downgrade rules to make a change pass.
