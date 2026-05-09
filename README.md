# yoda

Landing page for the yoda tools collection. Lists all available tools as clickable cards linking to their respective subdomains.

## Structure

```
yoda/
├── index.html   # Single-page listing of all tools
├── style.css    # Dark theme (shared color palette with all tools)
└── favicon.svg  # Monogram favicon
```

## Adding a project

Add a new `<a class="project-card">` block inside the `.project-grid` in `index.html`:

```html
<a class="project-card" href="https://your-tool.simbados.com">
  <div class="project-header">
    <span class="project-name">tool-name</span>
    <span class="project-tag">category</span>
  </div>
  <p class="project-desc">One or two sentences describing what the tool does.</p>
  <span class="project-link">Open tool ↗</span>
</a>
```

## Design

Uses the shared dark theme (`#0f172a` background, `#818cf8` accent) consistent across all tools in the collection. The project grid uses CSS `auto-fill` so new cards reflow automatically without any layout changes.
