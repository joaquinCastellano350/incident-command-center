# UI Implementation

Use shadcn/ui as the source of every interface primitive and compose application screens from the generated components under `apps/web/src/components/ui/`.

For each UI task:

1. Search the connected shadcn registry and inspect the relevant examples before writing the screen.
2. Add the selected components through the shadcn CLI so their source and dependencies remain canonical.
3. Build domain-specific compositions from those primitives. Extend shadcn variants or semantic tokens when needed instead of recreating buttons, cards, alerts, inputs, dialogs, tables, navigation, or feedback components.
4. Use restrained, content-led layouts with flat solid surfaces, conventional spacing, and semantic theme tokens. Gradient declarations, decorative glow, and ornamental dashboard treatments are outside the visual system.
5. Run the shadcn audit checklist, formatting, type checking, and the relevant tests. Completion requires every interactive control and interface surface to map to a shadcn primitive or an explicitly documented missing primitive.
